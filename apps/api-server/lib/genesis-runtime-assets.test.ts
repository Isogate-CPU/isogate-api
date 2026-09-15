import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type RuntimeArtifact = {
  deployedBytecode: string;
  immutableReferences: Record<string, { start: number; length: number }[]>;
};

const here = dirname(fileURLToPath(import.meta.url));

async function artifact(path: string): Promise<RuntimeArtifact> {
  return JSON.parse(await readFile(path, "utf8")) as RuntimeArtifact;
}

test("production build packages reviewed Genesis v2 runtime artifacts", async () => {
  for (const name of ["genesis-v2-hook.json", "genesis-v2-lock.json"]) {
    const source = await artifact(resolve(here, "runtime-assets", name));
    const bundled = await artifact(resolve(here, "../../dist/runtime-assets", name));
    assert.equal(bundled.deployedBytecode, source.deployedBytecode);
    assert.deepEqual(bundled.immutableReferences, source.immutableReferences);
    assert.match(bundled.deployedBytecode, /^0x[0-9a-f]+$/);
    assert.ok(Object.keys(bundled.immutableReferences).length > 0);
  }
});