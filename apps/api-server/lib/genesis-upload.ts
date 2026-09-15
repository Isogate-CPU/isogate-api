import { encodeGenesisPngWithDigest } from "./genesis-png.ts";

export type PinataUploadResult = {
  cid: string;
  pngDigest: string;
};

export type GenesisUploadRecord = {
  ipfsCid: string | null;
  logoUri: string | null;
  pngDigest: string;
};

export const GENESIS_UPLOAD_STATUSES = ["pending", "uploading", "uploaded", "failed"] as const;
export type GenesisUploadStatus = typeof GENESIS_UPLOAD_STATUSES[number];
export const GENESIS_UPLOAD_LEASE_MS = 5 * 60_000;

/** Pinata must return a syntactically valid CID, never an arbitrary string. */
export function isValidIpfsCid(cid: string): boolean {
  // CIDv0 is a 34-byte SHA-256 multihash encoded as exactly 46 base58btc
  // characters. CIDv1 uses the lower-case base32 multibase prefix.
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)
    || /^b[a-z2-7]{10,255}$/.test(cid);
}

export function canClaimGenesisUpload(
  status: string,
  uploadStartedAt: Date | null = null,
  now = Date.now(),
): boolean {
  if (status === "pending" || status === "failed") return true;
  if (status !== "uploading" || !uploadStartedAt) return false;
  const startedAt = uploadStartedAt.getTime();
  return Number.isFinite(startedAt) && now - startedAt >= GENESIS_UPLOAD_LEASE_MS;
}

/**
 * Upload only bytes regenerated from the persisted approved snapshot. The
 * JWT is read here, never accepted as request data, and is never included in
 * an error or return value. The canonical PNG bytes and fixed Pinata request
 * options are deterministic, so a stale-lease retry reproduces the same CID
 * for a successful pin; persisted CIDs are still validated and write-once.
 */
export async function uploadGenesisSnapshot(
  recipe: { pixels: readonly number[]; symbol: string; pngDigest: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PinataUploadResult> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("Pinata upload is not configured.");
  const { png, pngDigest } = encodeGenesisPngWithDigest(recipe.pixels);
  if (pngDigest !== recipe.pngDigest) {
    throw new Error("Persisted genesis PNG digest does not match canonical bytes.");
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(png)], { type: "image/png" }),
    `${recipe.symbol.toLowerCase()}.png`,
  );
  const response = await fetchImpl("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!response.ok) throw new Error("Pinata upload failed.");
  const payload: unknown = await response.json();
  const cid = typeof payload === "object" && payload !== null && "IpfsHash" in payload
    ? (payload as { IpfsHash?: unknown }).IpfsHash
    : null;
  if (typeof cid !== "string" || !isValidIpfsCid(cid)) {
    throw new Error("Pinata upload returned an invalid CID.");
  }
  return { cid, pngDigest };
}

/**
 * CID and logo URI are write-once. A retry can safely return the already
 * persisted result, but can never replace it with a second Pinata CID.
 */
export function applyWriteOncePinataResult(
  current: GenesisUploadRecord,
  uploaded: PinataUploadResult,
): GenesisUploadRecord {
  if (current.ipfsCid) {
    if (current.ipfsCid !== uploaded.cid) {
      throw new Error("An IPFS CID is already persisted for this recipe.");
    }
    return current;
  }
  const logoUri = `ipfs://${uploaded.cid}`;
  if (current.logoUri && current.logoUri !== logoUri) {
    throw new Error("A logo URI is already persisted for this recipe.");
  }
  return {
    ...current,
    ipfsCid: uploaded.cid,
    logoUri: current.logoUri ?? logoUri,
  };
}