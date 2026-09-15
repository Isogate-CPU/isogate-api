import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyWriteOncePinataResult,
  canClaimGenesisUpload,
  GENESIS_UPLOAD_LEASE_MS,
  isValidIpfsCid,
  uploadGenesisSnapshot,
} from "./genesis-upload.ts";
import { encodeGenesisPngWithDigest } from "./genesis-png.ts";

const CID_V0 = "QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51";
const CID_V1 = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("CID validation accepts CIDv0/CIDv1 and rejects arbitrary strings", () => {
  assert.equal(isValidIpfsCid(CID_V0), true);
  assert.equal(isValidIpfsCid(CID_V1), true);
  assert.equal(isValidIpfsCid("bafy-test"), false);
  assert.equal(isValidIpfsCid("not-a-cid"), false);
});

test("upload claim only permits retryable states", () => {
  assert.equal(canClaimGenesisUpload("pending"), true);
  assert.equal(canClaimGenesisUpload("failed"), true);
  const now = Date.now();
  assert.equal(canClaimGenesisUpload("uploading", new Date(now - GENESIS_UPLOAD_LEASE_MS + 1), now), false);
  assert.equal(canClaimGenesisUpload("uploading", new Date(now - GENESIS_UPLOAD_LEASE_MS), now), true);
  assert.equal(canClaimGenesisUpload("uploaded"), false);
});

test("a claimed upload cannot be claimed by a concurrent caller", () => {
  let status = "pending";
  assert.equal(canClaimGenesisUpload(status), true);
  status = "uploading";
  assert.equal(canClaimGenesisUpload(status, new Date()), false);
});

test("Pinata result helper never replaces a persisted CID", () => {
  const current = {
    ipfsCid: "bafy-existing",
    logoUri: "ipfs://bafy-existing",
    pngDigest: "digest",
  };
  assert.deepEqual(
    applyWriteOncePinataResult(current, { cid: "bafy-existing", pngDigest: "digest" }),
    current,
  );
  assert.throws(() => applyWriteOncePinataResult(
    current,
    { cid: "bafy-other", pngDigest: "digest" },
  ));
  assert.throws(() => applyWriteOncePinataResult(
    { ipfsCid: null, logoUri: "ipfs://bafy-existing", pngDigest: "digest" },
    { cid: CID_V1, pngDigest: "digest" },
  ));
});

test("Pinata upload sends canonical PNG multipart bytes and digest", async () => {
  const { pngDigest } = encodeGenesisPngWithDigest(Array(256).fill(0));
  const previous = process.env.PINATA_JWT;
  process.env.PINATA_JWT = "test-jwt";
  let request: Request | undefined;
  try {
    const result = await uploadGenesisSnapshot(
      { pixels: Array(256).fill(0), symbol: "TESTAA", pngDigest },
      async (input, init) => {
        request = new Request(input, init);
        return new Response(JSON.stringify({ IpfsHash: CID_V1 }), { status: 200 });
      },
    );
    assert.equal(result.cid, CID_V1);
    assert.equal(result.pngDigest, pngDigest);
    assert.equal(request?.url, "https://api.pinata.cloud/pinning/pinFileToIPFS");
    assert.equal(request?.headers.get("authorization"), "Bearer test-jwt");
    const file = (await request?.formData())?.get("file");
    assert.ok(file && typeof file !== "string");
    assert.equal(file.type, "image/png");
  } finally {
    if (previous === undefined) delete process.env.PINATA_JWT;
    else process.env.PINATA_JWT = previous;
  }
});

test("Pinata upload rejects an unvalidated CID", async () => {
  const { pngDigest } = encodeGenesisPngWithDigest(Array(256).fill(0));
  const previous = process.env.PINATA_JWT;
  process.env.PINATA_JWT = "test-jwt";
  try {
    await assert.rejects(
      uploadGenesisSnapshot(
        { pixels: Array(256).fill(0), symbol: "TESTAA", pngDigest },
        async () => new Response(JSON.stringify({ IpfsHash: "arbitrary" }), { status: 200 }),
      ),
      /invalid CID/,
    );
  } finally {
    if (previous === undefined) delete process.env.PINATA_JWT;
    else process.env.PINATA_JWT = previous;
  }
});