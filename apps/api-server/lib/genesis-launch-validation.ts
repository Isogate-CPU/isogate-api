export const GENESIS_FINALITY_CONFIRMATIONS = 12n;
export const GENESIS_INITIAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const GENESIS_BURN = 1_000_000n * 10n ** 18n;
export const GENESIS_V2_FINAL_SUPPLY = GENESIS_INITIAL_SUPPLY - GENESIS_BURN;
export function normalizeGenesisAbiInteger(
  value: unknown,
  label: string,
  min: bigint,
  max: bigint,
): number {
  const integer = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
  if (integer === null || integer < min || integer > max) {
    throw new GenesisLaunchValidationError(`${label} is not an integer in ABI range`);
  }
  return Number(integer);
}
export function selectGenesisVersion(input: {
  activeVersion?: string;
  hasV2Infrastructure: boolean;
}): "v1" | "v2" {
  const selected = input.activeVersion || (input.hasV2Infrastructure ? "v2" : "v1");
  if (selected !== "v1" && selected !== "v2") {
    throw new Error("GENESIS_ACTIVE_VERSION must be v1 or v2");
  }
  return selected;
}

export class GenesisLaunchValidationError extends Error {
  readonly kind = "validation";
}
export class GenesisLaunchInfrastructureError extends Error {
  readonly kind = "infrastructure";
}
const invalid = (message: string): never => {
  throw new GenesisLaunchValidationError(message);
};
export function genesisLaunchErrorStatus(error: unknown): 409 | 502 {
  return error instanceof GenesisLaunchValidationError ? 409 : 502;
}

export type GenesisLaunchAccounting = {
  launchAmount: bigint;
  poolTokenAmount: bigint;
  poolDust: bigint;
  mappedTokenDust: bigint;
  deadBalance: bigint;
  eventPositionLock: string;
  mappedPositionLock: string;
  /** v1 remains the default so already-indexed Elvera/v1 launches reconcile unchanged. */
  version?: "v1" | "v2";
};
export function validateGenesisLaunchAccounting(value: GenesisLaunchAccounting): void {
  const v2 = value.version === "v2";
  if (value.launchAmount !== value.poolTokenAmount
    || value.launchAmount !== (v2 ? GENESIS_V2_FINAL_SUPPLY : GENESIS_INITIAL_SUPPLY - GENESIS_BURN)
    || value.poolDust !== value.mappedTokenDust
    || value.deadBalance !== (v2 ? value.poolDust : GENESIS_BURN + value.poolDust)
    || value.eventPositionLock.toLowerCase() !== value.mappedPositionLock.toLowerCase()) {
    invalid("Genesis launch accounting or position lock event does not match chain state");
  }
}
export function requireGenesisFinality(latestBlock: bigint, deploymentBlock: bigint, launchBlock: bigint): void {
  if (latestBlock < deploymentBlock + GENESIS_FINALITY_CONFIRMATIONS
    || latestBlock < launchBlock + GENESIS_FINALITY_CONFIRMATIONS) {
    invalid("Genesis transactions do not have twelve confirmations on the canonical chain");
  }
}