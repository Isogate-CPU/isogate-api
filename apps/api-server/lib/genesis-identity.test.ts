import assert from "node:assert/strict";
import { test } from "node:test";
import { runCpuArt } from "@isogate/replay";
import {
  approvalMessageDigest,
  buildGenesisApprovalMessage,
  recomputeVerifiedGenesisJob,
} from "./genesis-identity.ts";

const wallet = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const job = {
  id: "11111111-1111-4111-8111-111111111111",
  providerId: "22222222-2222-4222-8222-222222222222",
  workload: "cpu_art_rgb565",
  creatorWalletAddress: wallet,
  status: "completed",
  verificationStatus: "verified",
  inputs: [1, 2, 3, 4, 5, 6, 7, 8],
  result: runCpuArt({ seed: [1, 2, 3, 4, 5, 6, 7, 8] }),
};

test("approval snapshot binds canonical PNG and every identity field", () => {
  const snapshot = recomputeVerifiedGenesisJob(job, wallet);
  const message = buildGenesisApprovalMessage({
    jobId: job.id,
    providerId: job.providerId,
    creatorWalletAddress: wallet,
    chainId: 4663,
    expiresAt: "2030-01-01T00:00:00.000Z",
    nonce: "ab".repeat(32),
    snapshot,
  });
  assert.match(message, new RegExp(`PNG Digest: ${snapshot.pngDigest}`));
  assert.match(message, new RegExp(`CPU Digest: ${snapshot.canonical.cpuDigest}`));
  assert.match(message, new RegExp(`Image Digest: ${snapshot.canonical.imageDigest}`));
  assert.match(message, new RegExp(`Provider ID: ${job.providerId}`));
  assert.match(message, /Protocol Version: isogate-genesis-approval-v2/);
  assert.doesNotMatch(message, /Genesis digest/i);
});

test("approval snapshot rejects altered Native Node results or creator", () => {
  assert.throws(() => recomputeVerifiedGenesisJob(
    { ...job, result: { ...job.result, symbol: "ALTERED" } },
    wallet,
  ));
  assert.throws(() => recomputeVerifiedGenesisJob(job, "0x2222222222222222222222222222222222222222"));
});

test("approval snapshot accepts canonical results after jsonb reorders object keys", () => {
  const reorderedResult = Object.fromEntries(Object.entries(job.result).reverse());
  const snapshot = recomputeVerifiedGenesisJob({ ...job, result: reorderedResult }, wallet);
  assert.deepEqual(snapshot.canonical, job.result);
});

test("independent challenge messages remain independently bound", () => {
  const snapshot = recomputeVerifiedGenesisJob(job, wallet);
  const first = buildGenesisApprovalMessage({
    jobId: job.id,
    providerId: job.providerId,
    creatorWalletAddress: wallet,
    chainId: 4663,
    expiresAt: "2030-01-01T00:00:00.000Z",
    nonce: "01".repeat(32),
    snapshot,
  });
  const second = buildGenesisApprovalMessage({
    jobId: job.id,
    providerId: job.providerId,
    creatorWalletAddress: wallet,
    chainId: 4663,
    expiresAt: "2030-01-01T00:10:00.000Z",
    nonce: "02".repeat(32),
    snapshot,
  });
  assert.notEqual(approvalMessageDigest(first), approvalMessageDigest(second));
  assert.match(first, /Nonce: 010101/);
  assert.match(second, /Nonce: 020202/);
});