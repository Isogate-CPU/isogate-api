import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeGenesisPngWithDigest } from "./genesis-png.ts";

test("canonical RGB565 PNG vector is byte-stable", () => {
  const { png, pngDigest } = encodeGenesisPngWithDigest(Array(256).fill(0));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  assert.equal(pngDigest, "4eac9497a0a56a645da6186816026fb5a655ab6d55bb9cfcbf8149380db9ebf2");
  assert.deepEqual(
    encodeGenesisPngWithDigest(Array(256).fill(0)),
    { png, pngDigest },
  );
});

test("canonical PNG rejects non-RGB565 recipes", () => {
  assert.throws(() => encodeGenesisPngWithDigest(Array(255).fill(0)));
  assert.throws(() => encodeGenesisPngWithDigest([...Array(255).fill(0), 0x1_0000]));
});