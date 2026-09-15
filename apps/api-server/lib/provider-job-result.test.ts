import assert from "node:assert/strict";
import test from "node:test";
// The Node test runner executes this source directly with type stripping.
import { canonicalProviderJobDigest, canonicalProviderJobDigestAlgorithm, canonicalProviderJobResult } from "./provider-job-result.ts";

const inputs = [0, 17, 34, 51, 68, 85, 102, 119];

test("RGB565 jobs verify and produce receipt metadata from the canonical art result", () => {
  const result = canonicalProviderJobResult({
    workload: "cpu_art_rgb565",
    inputs,
    cycles: 32,
  });

  assert.equal(result.engine, "isogate-cpu-art-rgb565-v1");
  assert.ok("imageDigest" in result);
  assert.equal(result.pixels.length, 256);
  assert.equal(canonicalProviderJobDigest(result), result.imageDigest);
  assert.equal(canonicalProviderJobDigestAlgorithm(), "SHA-256");
});

test("replay jobs retain their existing verification and receipt behavior", () => {
  const result = canonicalProviderJobResult({
    workload: "cpu_replay",
    inputs,
    cycles: 32,
  });

  assert.equal(result.engine, "isogate-deterministic-replay-v1");
  assert.equal(canonicalProviderJobDigest(result), result.digest);
  assert.equal(canonicalProviderJobDigestAlgorithm(), result.digestAlgorithm);
});