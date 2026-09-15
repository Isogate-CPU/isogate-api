import assert from "node:assert/strict";
import test from "node:test";
import { ReconcileGenesisLaunchBody } from "@isogate/api-zod";
import {
  GENESIS_FINALITY_CONFIRMATIONS,
  GENESIS_V2_FINAL_SUPPLY,
  GenesisLaunchValidationError,
  genesisLaunchErrorStatus,
  normalizeGenesisAbiInteger,
  requireGenesisFinality,
  selectGenesisVersion,
  validateGenesisLaunchAccounting,
} from "./genesis-launch-validation.ts";

const amount = 999_000_000n * 10n ** 18n;
const burn = 1_000_000n * 10n ** 18n;
const lock = "0x1111111111111111111111111111111111111111";

function accounting(overrides: Partial<Parameters<typeof validateGenesisLaunchAccounting>[0]> = {}) {
  return {
    launchAmount: amount,
    poolTokenAmount: amount,
    poolDust: 17n,
    mappedTokenDust: 17n,
    deadBalance: burn + 17n,
    eventPositionLock: lock,
    mappedPositionLock: lock,
    ...overrides,
  };
}

test("Genesis reconciliation rejects mismatched dust and dead balance", () => {
  assert.throws(
    () => validateGenesisLaunchAccounting(accounting({ mappedTokenDust: 18n })),
    GenesisLaunchValidationError,
  );
  assert.throws(
    () => validateGenesisLaunchAccounting(accounting({ deadBalance: burn })),
    GenesisLaunchValidationError,
  );
});

test("Genesis v2 reconciliation uses final supply and dead-address dust only", () => {
  assert.doesNotThrow(() => validateGenesisLaunchAccounting({
    launchAmount: GENESIS_V2_FINAL_SUPPLY,
    poolTokenAmount: GENESIS_V2_FINAL_SUPPLY,
    poolDust: 17n,
    mappedTokenDust: 17n,
    deadBalance: 17n,
    eventPositionLock: lock,
    mappedPositionLock: lock,
    version: "v2",
  }));
});

test("Genesis routing selects trusted explicit v1/v2 configuration, not supply arithmetic", () => {
  assert.equal(selectGenesisVersion({ hasV2Infrastructure: true }), "v2");
  assert.equal(selectGenesisVersion({ activeVersion: "v1", hasV2Infrastructure: true }), "v1");
  assert.throws(() => selectGenesisVersion({ activeVersion: "v3", hasV2Infrastructure: true }));
});

test("Genesis reconciliation requires an explicit trusted infrastructure version", () => {
  const hashes = {
    deploymentTxHash: `0x${"11".repeat(32)}`,
    launchTxHash: `0x${"22".repeat(32)}`,
  };
  assert.equal(ReconcileGenesisLaunchBody.safeParse(hashes).success, false);
  assert.equal(ReconcileGenesisLaunchBody.safeParse({ ...hashes, version: "v2" }).success, true);
  assert.equal(ReconcileGenesisLaunchBody.safeParse({ ...hashes, version: "v3" }).success, false);
});

test("Pool ABI integers normalize numbers and bigint without coercing invalid values", () => {
  assert.equal(normalizeGenesisAbiInteger(10_000, "fee", 0n, 0xff_ffffn), 10_000);
  assert.equal(normalizeGenesisAbiInteger(200n, "spacing", -0x80_0000n, 0x7f_ffffn), 200);
  assert.throws(() => normalizeGenesisAbiInteger(1.5, "fee", 0n, 0xff_ffffn), GenesisLaunchValidationError);
  assert.throws(() => normalizeGenesisAbiInteger(0x1_000_000, "fee", 0n, 0xff_ffffn), GenesisLaunchValidationError);
  assert.throws(() => normalizeGenesisAbiInteger(-0x80_0001, "spacing", -0x80_0000n, 0x7f_ffffn), GenesisLaunchValidationError);
});

test("Genesis reconciliation rejects event amount and position-lock mismatches", () => {
  assert.throws(
    () => validateGenesisLaunchAccounting(accounting({ poolTokenAmount: amount - 1n })),
    GenesisLaunchValidationError,
  );
  assert.throws(
    () => validateGenesisLaunchAccounting(accounting({ mappedPositionLock: "0x2222222222222222222222222222222222222222" })),
    GenesisLaunchValidationError,
  );
});

test("Genesis reconciliation requires twelve confirmations", () => {
  assert.doesNotThrow(() => requireGenesisFinality(112n, 90n, 100n));
  assert.throws(
    () => requireGenesisFinality(111n, 90n, 100n),
    GenesisLaunchValidationError,
  );
  assert.equal(GENESIS_FINALITY_CONFIRMATIONS, 12n);
});

test("Genesis verification distinguishes invalid pairs from unavailable infrastructure", () => {
  assert.equal(genesisLaunchErrorStatus(new GenesisLaunchValidationError("event mismatch")), 409);
  assert.equal(genesisLaunchErrorStatus(new Error("RPC timeout")), 502);
});