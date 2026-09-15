import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getAddress, keccak256, stringToHex, toHex } from "viem";
import type { CpuArtResult } from "@isogate/replay";
import { runCpuArt } from "@isogate/replay";
import { encodeGenesisPngWithDigest } from "./genesis-png.ts";

export const GENESIS_APPROVAL_PROTOCOL_VERSION = "isogate-genesis-approval-v2";

export type VerifiedGenesisJob = {
  id: string;
  providerId: string;
  workload: string;
  creatorWalletAddress: string | null;
  status: string;
  verificationStatus: string;
  inputs: unknown;
  result: unknown;
};

export type GenesisCanonicalSnapshot = {
  canonical: CpuArtResult;
  png: Buffer;
  pngDigest: string;
  metadata: {
    tokenNameHash: string;
    symbolHash: string;
    descriptionHash: string;
    seedHash: string;
    cpuDigest: string;
    imageDigest: string;
  };
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function metadataHashes(result: CpuArtResult) {
  return {
    tokenNameHash: keccak256(stringToHex(result.tokenName)),
    symbolHash: keccak256(stringToHex(result.symbol)),
    descriptionHash: keccak256(stringToHex(result.description)),
    seedHash: keccak256(toHex(Uint8Array.from(result.seed))),
    cpuDigest: result.cpuDigest,
    imageDigest: result.imageDigest,
  };
}

/**
 * Recompute every approval-bound value. This is intentionally independent of
 * deployment attestation: an approved snapshot is useful before contracts are
 * deployed and must not depend on a server session secret.
 */
export function recomputeVerifiedGenesisJob(
  job: VerifiedGenesisJob,
  requestedWallet: string,
): GenesisCanonicalSnapshot {
  const creator = getAddress(requestedWallet);
  if (
    job.workload !== "cpu_art_rgb565"
    || job.status !== "completed"
    || job.verificationStatus !== "verified"
    || !job.creatorWalletAddress
    || getAddress(job.creatorWalletAddress) !== creator
  ) {
    throw new Error("Only the verified creator job can produce an approval snapshot.");
  }
  const canonical = runCpuArt({ seed: job.inputs as number[] });
  // PostgreSQL jsonb does not preserve object key insertion order. Compare
  // values structurally so a database round trip cannot reject a canonical
  // Native Node result solely because its keys were reordered.
  if (!isDeepStrictEqual(job.result, canonical)) {
    throw new Error("The stored provider result no longer matches canonical recomputation.");
  }
  const { png, pngDigest } = encodeGenesisPngWithDigest(canonical.pixels);
  return {
    canonical,
    png,
    pngDigest,
    metadata: metadataHashes(canonical),
  };
}

export function buildGenesisApprovalMessage(input: {
  jobId: string;
  providerId: string;
  creatorWalletAddress: string;
  chainId: number;
  expiresAt: string;
  nonce: string;
  snapshot: GenesisCanonicalSnapshot;
}) {
  const { canonical, pngDigest, metadata } = input.snapshot;
  return [
    `Protocol Version: ${GENESIS_APPROVAL_PROTOCOL_VERSION}`,
    `Job ID: ${input.jobId}`,
    `Provider ID: ${input.providerId}`,
    `Creator Wallet: ${getAddress(input.creatorWalletAddress)}`,
    `Chain ID: ${input.chainId}`,
    `Token Name Hash: ${metadata.tokenNameHash}`,
    `Symbol Hash: ${metadata.symbolHash}`,
    `Description Hash: ${metadata.descriptionHash}`,
    `Seed Hash: ${metadata.seedHash}`,
    `CPU Digest: ${canonical.cpuDigest}`,
    `Image Digest: ${canonical.imageDigest}`,
    `PNG Digest: ${pngDigest}`,
    `Nonce: ${input.nonce}`,
    `Expires At: ${input.expiresAt}`,
    "Sign this message with your wallet using personal_sign.",
  ].join("\n");
}

export function approvalNonceHash(nonce: string) {
  return sha256(nonce);
}

export function approvalMessageDigest(message: string) {
  return sha256(message);
}