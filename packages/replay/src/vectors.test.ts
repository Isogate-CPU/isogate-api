import assert from "node:assert/strict";
import test from "node:test";
import { runCpuArt, runCpuReplay } from "./index.js";
import { REPLAY_TEST_INPUTS, REPLAY_TEST_VECTORS } from "./vectors.js";

test("canonical replay vectors preserve partial and halted state parity", () => {
  for (const vector of REPLAY_TEST_VECTORS) {
    const result = runCpuReplay({ inputs: [...REPLAY_TEST_INPUTS], cycles: vector.cycles });
    assert.equal(result.digest, vector.digest, `digest drift at cycle ${vector.cycles}`);
    assert.equal(result.finalState.halted, vector.halted, `halted drift at cycle ${vector.cycles}`);
  }
});

test("CPU art is deterministic and contains canonical RGB565 output", () => {
  const first = runCpuArt({ seed: [...REPLAY_TEST_INPUTS] });
  const second = runCpuArt({ seed: [...REPLAY_TEST_INPUTS] });

  assert.deepEqual(first, second);
  assert.equal(first.pixels.length, 256);
  assert.equal(first.bitsPerPixel, 16);
  assert.equal(first.colorModel, "RGB565");
  assert.match(first.cpuDigest, /^[a-f0-9]{64}$/);
  assert.match(first.imageDigest, /^[a-f0-9]{64}$/);
  assert.match(first.symbol, /^[A-Z2-9]{6}$/);
  assert.match(first.description, /^A .+ by the Isogate deterministic CPU\.$/);
});