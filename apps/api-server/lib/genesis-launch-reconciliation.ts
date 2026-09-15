import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  type Address,
  type Hash,
} from "viem";
import { getAddress } from "viem";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, approvedGenesisRecipesTable, type ApprovedGenesisRecipe } from "@isogate/db";
import {
  GENESIS_BURN,
  GENESIS_FINALITY_CONFIRMATIONS,
  GENESIS_INITIAL_SUPPLY,
  GENESIS_V2_FINAL_SUPPLY,
  GenesisLaunchInfrastructureError,
  GenesisLaunchValidationError,
  genesisLaunchErrorStatus,
  requireGenesisFinality,
  normalizeGenesisAbiInteger,
  validateGenesisLaunchAccounting,
} from "./genesis-launch-validation.ts";
export {
  GENESIS_FINALITY_CONFIRMATIONS,
  GenesisLaunchInfrastructureError,
  GenesisLaunchValidationError,
  genesisLaunchErrorStatus,
  requireGenesisFinality,
  selectGenesisVersion,
  validateGenesisLaunchAccounting,
} from "./genesis-launch-validation.ts";

export const GENESIS_CHAIN_ID = 4663;
export const GENESIS_V2_VERSION = "v2";
export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com/";
export const BLOCKSCOUT_BASE_URL = "https://explorer.mainnet.robinhood.com";

const factoryEventsAbi = [
  {
    type: "event", name: "GenesisDeployed",
    inputs: [
      { indexed: true, name: "genesisDigest", type: "bytes32" },
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "name", type: "string" },
      { indexed: false, name: "symbol_", type: "string" },
      { indexed: false, name: "logoUri", type: "string" },
    ],
  },
  {
    type: "event", name: "GenesisFeeVaultCreated",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "vault", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: false, name: "protocol", type: "address" },
      { indexed: false, name: "weth", type: "address" },
    ],
  },
  {
    type: "event", name: "GenesisLaunched",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
] as const;

const coordinatorEventsAbi = [
  {
    type: "event", name: "GenesisPoolLaunched",
    inputs: [
      { indexed: true, name: "token", type: "address" },
      { indexed: true, name: "creator", type: "address" },
      { indexed: true, name: "feeVault", type: "address" },
      { indexed: false, name: "positionLock", type: "address" },
      { indexed: false, name: "positionTokenId", type: "uint256" },
      { indexed: false, name: "tickLower", type: "int24" },
      { indexed: false, name: "tickUpper", type: "int24" },
      { indexed: false, name: "tokenAmount", type: "uint256" },
      { indexed: false, name: "nativeAmount", type: "uint256" },
      { indexed: false, name: "tokenDust", type: "uint256" },
    ],
  },
] as const;
const poolManagerEventsAbi = [
  {
    type: "event", name: "Initialize",
    inputs: [
      { indexed: true, name: "id", type: "bytes32" },
      { indexed: true, name: "currency0", type: "address" },
      { indexed: true, name: "currency1", type: "address" },
      { indexed: false, name: "fee", type: "uint24" },
      { indexed: false, name: "tickSpacing", type: "int24" },
      { indexed: false, name: "hooks", type: "address" },
      { indexed: false, name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, name: "tick", type: "int24" },
    ],
  },
] as const;

const factoryReadAbi = [
  { type: "function", name: "tokenByGenesisDigest", stateMutability: "view", inputs: [{ name: "digest", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "creatorOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "feeVaultOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "launchCoordinator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const coordinatorReadAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "positionManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "launched", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "hookOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "positionLockOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "poolIdOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "tokenDustOf", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const positionReadAbi = [
  {
    type: "function", name: "getPoolAndPositionInfo", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{
      name: "poolKey", type: "tuple", components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    }, { name: "info", type: "bytes32" }],
  },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getPositionLiquidity", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "uint128" }] },
] as const;
const poolManagerReadAbi = [
  { type: "function", name: "extsload", stateMutability: "view", inputs: [{ name: "slot", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
] as const;
const lockReadAbi = [
  { type: "function", name: "positionManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "tokenId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "genesisToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeVault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "currency0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "currency1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const registryReadAbi = [
  {
    type: "function", name: "approvedIdentity", stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [{
      type: "tuple", components: [
        { name: "creator", type: "address" }, { name: "factory", type: "address" },
        { name: "protocol", type: "address" }, { name: "name", type: "string" },
        { name: "symbol", type: "string" }, { name: "logoUri", type: "string" },
        { name: "providerJobRef", type: "bytes32" }, { name: "providerRef", type: "bytes32" },
        { name: "expiry", type: "uint256" }, { name: "nonce", type: "uint256" },
        { name: "approved", type: "bool" },
      ],
    }],
  },
] as const;
const tokenReadAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "logo", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "genesisDigest", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "launchRecipient", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const tokenEventsAbi = [
  {
    type: "event", name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;
const tokenOwnerAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const feeVaultReadAbi = [
  { type: "function", name: "creator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "protocol", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "weth", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "genesisToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "creatorNativeDue", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creatorWethDue", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "creatorGenesisTokenDue", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;
const INITIAL_SUPPLY = GENESIS_INITIAL_SUPPLY;
const equalAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const equalHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Config = {
  version: "v1" | "v2";
  registry: Address; factory: Address; coordinator: Address; protocol: Address; weth: Address; rpcUrl: string;
  poolManager: Address; positionManager: Address;
  sqrtPriceX96: bigint;
};
type EventLog = { address: Address; data: `0x${string}`; topics: readonly `0x${string}`[] };
type Decoded = { eventName: string; args: Record<string, unknown> };

const invalid = (message: string): never => {
  throw new GenesisLaunchValidationError(message);
};

function configuredAddress(...names: string[]): Address {
  const name = names.find((candidate) => process.env[candidate]);
  const value = name ? process.env[name] : undefined;
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${names[0]} is not configured`);
  return getAddress(value);
}

export type GenesisVersion = "v1" | "v2";

export function genesisPublicConfig(version: GenesisVersion): Config {
  const prefix = version === "v2" ? "GENESIS_V2_" : "GENESIS_";
  if (version === "v2") {
    for (const suffix of ["REGISTRY_ADDRESS", "FACTORY_ADDRESS", "COORDINATOR_ADDRESS", "PROTOCOL_ADDRESS", "WETH_ADDRESS", "POOL_MANAGER_ADDRESS", "POSITION_MANAGER_ADDRESS"]) {
      if (!process.env[`${prefix}${suffix}`]) throw new Error(`${prefix}${suffix} is required for v2 routing`);
    }
  }
  const envAddress = (suffix: string) => configuredAddress(`${prefix}${suffix}`);
  return {
    version,
    registry: envAddress("REGISTRY_ADDRESS"),
    factory: envAddress("FACTORY_ADDRESS"),
    coordinator: envAddress("COORDINATOR_ADDRESS"),
    protocol: envAddress("PROTOCOL_ADDRESS"),
    weth: process.env[`${prefix}WETH_ADDRESS`]
      ? envAddress("WETH_ADDRESS")
      : getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
    poolManager: process.env[`${prefix}POOL_MANAGER_ADDRESS`]
      ? envAddress("POOL_MANAGER_ADDRESS")
      : getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
    positionManager: process.env[`${prefix}POSITION_MANAGER_ADDRESS`]
      ? envAddress("POSITION_MANAGER_ADDRESS")
      : getAddress("0x58daec3116aae6D93017bAAea7749052E8a04fA7"),
    rpcUrl: process.env.GENESIS_ROBINHOOD_RPC_URL || process.env.ROBINHOOD_RPC_URL || ROBINHOOD_RPC_URL,
    sqrtPriceX96: version === "v2" ? 34_500n * (1n << 96n) : 25_000n * (1n << 96n),
  };
}

function decode(abi: readonly unknown[], log: EventLog): Decoded | null {
  try {
    const result = decodeEventLog({ abi: abi as never, data: log.data, topics: log.topics as never }) as unknown as Decoded;
    return result;
  } catch {
    return null;
  }
}

function findEvent(logs: readonly EventLog[], abi: readonly unknown[], address: Address, name: string): Decoded {
  const found = logs
    .filter((log) => equalAddress(log.address, address))
    .map((log) => decode(abi, log))
    .find((event) => event?.eventName === name);
  if (!found) invalid(`Missing ${name} event`);
  return found!;
}

function canonicalLogo(uri: string): string {
  if (!uri.startsWith("ipfs://")) invalid("Token logo URI is not canonical");
  const cid = uri.slice(7);
  if ((cid.startsWith("Qm") && cid.length === 46 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(cid))
    || (cid.startsWith("b") && cid.length >= 50 && cid.length <= 128 && /^b[a-z2-7]+$/.test(cid))) return cid;
  return invalid("Token logo URI is not canonical");
}

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalid(`${label} is invalid`);
  return getAddress(value as string);
}
function asHash(value: unknown, label: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(`${label} is invalid`);
  return value as Hash;
}
function asBigint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") invalid(`${label} is invalid`);
  return value as bigint;
}
type RuntimeArtifact = {
  deployedBytecode: string;
  immutableReferences?: Record<string, { start: number; length: number }[]>;
};
async function runtimeArtifact(contract: "hook" | "lock", version: GenesisVersion): Promise<RuntimeArtifact | null> {
  const configured = process.env[`GENESIS_${version.toUpperCase()}_${contract.toUpperCase()}_ARTIFACT_PATH`];
  if (version === "v1" && !configured) return null;
  const candidates = configured ? [configured] : [
    fileURLToPath(new URL(
      `./runtime-assets/${contract === "hook" ? "genesis-v2-hook.json" : "genesis-v2-lock.json"}`,
      import.meta.url,
    )),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as RuntimeArtifact;
    } catch {
      // Try the next configured/portable artifact location.
    }
  }
  throw new GenesisLaunchInfrastructureError(`Missing reviewed ${contract} runtime artifact`);
}

export async function assertGenesisV2RuntimeAssetsAvailable(): Promise<void> {
  const artifacts = await Promise.all([
    runtimeArtifact("hook", "v2"),
    runtimeArtifact("lock", "v2"),
  ]);
  for (const artifact of artifacts) {
    if (!artifact?.deployedBytecode || !artifact.immutableReferences
      || Object.keys(artifact.immutableReferences).length === 0) {
      throw new GenesisLaunchInfrastructureError("Reviewed Genesis v2 runtime artifact is incomplete");
    }
  }
}
function patchedRuntimeHash(artifact: RuntimeArtifact, values: readonly (Address | bigint)[]): Hash {
  const runtime = artifact.deployedBytecode.replace(/^0x/, "");
  if (!runtime || runtime.length % 2 !== 0 || !artifact.immutableReferences) {
    throw new GenesisLaunchInfrastructureError("Reviewed runtime artifact lacks immutable references");
  }
  const bytes = Buffer.from(runtime, "hex");
  const references = Object.entries(artifact.immutableReferences)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, locations]) => locations);
  if (references.length !== values.length) {
    throw new GenesisLaunchInfrastructureError("Runtime immutable reference count does not match constructor");
  }
  references.forEach((locations, index) => {
    const value = values[index];
    const hex = typeof value === "bigint"
      ? value.toString(16).padStart(64, "0")
      : value.slice(2).toLowerCase().padStart(64, "0");
    for (const location of locations) {
      if (location.length !== 32 || location.start < 0 || location.start + location.length > bytes.length) {
        throw new GenesisLaunchInfrastructureError("Runtime immutable reference is out of bounds");
      }
      Buffer.from(hex, "hex").copy(bytes, location.start, 0, location.length);
    }
  });
  return keccak256(`0x${bytes.toString("hex")}` as Hash);
}
async function resolveVersionForTarget(
  client: ReturnType<typeof createPublicClient>,
  target: Address | null,
): Promise<GenesisVersion> {
  if (!target) invalid("Genesis transaction has no target");
  const targetAddress = target as Address;
  const matches: GenesisVersion[] = [];
  for (const version of ["v2", "v1"] as const) {
    try {
      const config = genesisPublicConfig(version);
      if (equalAddress(config.factory, targetAddress)) matches.push(version);
    } catch {
      // An unconfigured historical/future route is not a candidate.
    }
  }
  if (matches.length !== 1) invalid("Genesis transaction target does not select exactly one trusted version");
  return matches[0];
}

export type VerifiedGenesisLaunch = {
  version: GenesisVersion; chainId: number; creatorWalletAddress: string; genesisDigest: string; tokenAddress: string;
  feeVaultAddress: string; hookAddress: string; positionLockAddress: string; poolId: string;
  positionTokenId: bigint; tokenName: string; symbol: string; logoUri: string; logoCid: string;
  deploymentTxHash: string; deploymentBlockNumber: bigint; deploymentBlockHash: string; deploymentTimestamp: Date;
  launchTxHash: string; launchBlockNumber: bigint; launchBlockHash: string; launchTimestamp: Date;
};

async function verifyGenesisLaunchInternal(deploymentTxHash: Hash, launchTxHash: Hash, version: GenesisVersion): Promise<VerifiedGenesisLaunch> {
  const config = genesisPublicConfig(version);
  const client = createPublicClient({
    chain: { id: GENESIS_CHAIN_ID, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } },
    transport: http(config.rpcUrl),
  });
  if (await client.getChainId() !== GENESIS_CHAIN_ID) throw new GenesisLaunchInfrastructureError("Genesis RPC is not Robinhood Chain 4663");
  const [deploymentTx, deploymentReceipt, launchTx, launchReceipt] = await Promise.all([
    client.getTransaction({ hash: deploymentTxHash }),
    client.getTransactionReceipt({ hash: deploymentTxHash }),
    client.getTransaction({ hash: launchTxHash }),
    client.getTransactionReceipt({ hash: launchTxHash }),
  ]);
  if (deploymentReceipt.status !== "success" || launchReceipt.status !== "success") invalid("Genesis transaction was not successful");
  if (!deploymentTx.to || !equalAddress(deploymentTx.to, config.factory) || !launchTx.to || !equalAddress(launchTx.to, config.factory)) {
    invalid("Genesis transaction target is not the configured factory");
  }
  const deployment = findEvent(deploymentReceipt.logs as unknown as EventLog[], factoryEventsAbi, config.factory, "GenesisDeployed");
  const vaultCreated = findEvent(deploymentReceipt.logs as unknown as EventLog[], factoryEventsAbi, config.factory, "GenesisFeeVaultCreated");
  const launch = findEvent(launchReceipt.logs as unknown as EventLog[], factoryEventsAbi, config.factory, "GenesisLaunched");
  const poolLaunch = findEvent(launchReceipt.logs as unknown as EventLog[], coordinatorEventsAbi, config.coordinator, "GenesisPoolLaunched");
  const da = deployment.args;
  const va = vaultCreated.args;
  const la = launch.args;
  const pa = poolLaunch.args;
  const digest = asHash(da.genesisDigest, "genesis digest");
  const token = asAddress(da.token, "token");
  const creator = asAddress(da.creator, "creator");
  const feeVault = asAddress(va.vault, "fee vault");
  const launchedToken = asAddress(la.token, "launched token");
  const poolToken = asAddress(pa.token, "pool token");
  const launchAmount = asBigint(la.amount, "launch amount");
  const poolTokenAmount = asBigint(pa.tokenAmount, "pool token amount");
  const poolDust = asBigint(pa.tokenDust, "pool token dust");
  const eventPositionLock = asAddress(pa.positionLock, "event position lock");
  const eventRecipient = asAddress(la.recipient, "launch recipient");
  if (!equalAddress(deploymentTx.from, creator) || !equalAddress(launchTx.from, creator)
    || !equalAddress(asAddress(va.token, "vault token"), token) || !equalAddress(asAddress(va.creator, "vault creator"), creator)
    || !equalAddress(launchedToken, token) || !equalAddress(asAddress(la.creator, "launch creator"), creator)
    || !equalAddress(poolToken, token) || !equalAddress(asAddress(pa.creator, "pool creator"), creator)
    || !equalAddress(asAddress(pa.feeVault, "pool fee vault"), feeVault)
    || !equalAddress(eventRecipient, config.coordinator)) invalid("Genesis events do not agree");
  const name = String(da.name);
  const symbol = String(da.symbol_);
  const logoUri = String(da.logoUri);
  const logoCid = canonicalLogo(logoUri);

  const identity = await client.readContract({ address: config.registry, abi: registryReadAbi, functionName: "approvedIdentity", args: [digest] }) as unknown as Record<string, unknown>;
  const identityCreator = asAddress(identity.creator, "identity creator");
  if (!identity.approved || !equalAddress(identityCreator, creator)
    || !equalAddress(asAddress(identity.factory, "identity factory"), config.factory)
    || !equalAddress(asAddress(identity.protocol, "identity protocol"), config.protocol)
    || identity.name !== name || identity.symbol !== symbol || identity.logoUri !== logoUri) invalid("Registry identity does not match Genesis deployment");

  const [mappedToken, mappedCreator, mappedVault, configuredCoordinator, coordinatorPoolManager, coordinatorPositionManager, coordinatorFactory, launched, hook, lock, poolId, tokenDust, tokenName, tokenSymbol, tokenLogo, totalSupply, burned, zeroAddressBalance, creatorBalance, tokenCreator, tokenDigest, launchRecipient, vaultCreator, vaultProtocol, vaultWeth, vaultToken] = await Promise.all([
    client.readContract({ address: config.factory, abi: factoryReadAbi, functionName: "tokenByGenesisDigest", args: [digest] }),
    client.readContract({ address: config.factory, abi: factoryReadAbi, functionName: "creatorOf", args: [token] }),
    client.readContract({ address: config.factory, abi: factoryReadAbi, functionName: "feeVaultOf", args: [token] }),
    client.readContract({ address: config.factory, abi: factoryReadAbi, functionName: "launchCoordinator" }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "poolManager" }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "positionManager" }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "factory" }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "launched", args: [token] }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "hookOf", args: [token] }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "positionLockOf", args: [token] }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "poolIdOf", args: [token] }),
    client.readContract({ address: config.coordinator, abi: coordinatorReadAbi, functionName: "tokenDustOf", args: [token] }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "name" }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "symbol" }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "logo" }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "totalSupply" }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "balanceOf", args: [DEAD_ADDRESS] }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "balanceOf", args: ["0x0000000000000000000000000000000000000000"] }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "balanceOf", args: [creator] }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "creator" }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "genesisDigest" }),
    client.readContract({ address: token, abi: tokenReadAbi, functionName: "launchRecipient" }),
    client.readContract({ address: feeVault, abi: feeVaultReadAbi, functionName: "creator" }),
    client.readContract({ address: feeVault, abi: feeVaultReadAbi, functionName: "protocol" }),
    client.readContract({ address: feeVault, abi: feeVaultReadAbi, functionName: "weth" }),
    client.readContract({ address: feeVault, abi: feeVaultReadAbi, functionName: "genesisToken" }),
  ]);
  const expectedFinalSupply = config.version === "v2" ? GENESIS_V2_FINAL_SUPPLY : INITIAL_SUPPLY;
  if (totalSupply !== expectedFinalSupply) invalid("Genesis token supply does not match trusted infrastructure version");
  const isV2 = config.version === "v2";
  if (isV2) {
    const owner = await client.readContract({ address: token, abi: tokenOwnerAbi, functionName: "owner" });
    if (!equalAddress(owner, "0x0000000000000000000000000000000000000000")) {
      invalid("Genesis v2 token ownership is not renounced");
    }
    const burn = (deploymentReceipt.logs as unknown as EventLog[])
      .filter((log) => equalAddress(log.address, token))
      .map((log) => decode(tokenEventsAbi, log))
      .find((event) => {
        if (!event || event.eventName !== "Transfer") return false;
        const args = event.args;
        return typeof args.to === "string"
          && equalAddress(args.to, "0x0000000000000000000000000000000000000000")
          && args.value === GENESIS_BURN;
      });
    if (!burn) {
      throw new GenesisLaunchValidationError("Missing Genesis v2 zero-address burn Transfer event");
    }
    const ba = burn.args;
    if (!equalAddress(asAddress(ba.from, "genesis burn source"), asAddress(launchRecipient, "launch recipient"))
      || !equalAddress(asAddress(ba.to, "genesis burn destination"), "0x0000000000000000000000000000000000000000")
      || asBigint(ba.value, "genesis burn amount") !== GENESIS_BURN
      || zeroAddressBalance !== 0n) {
      invalid("Genesis v2 burn must be a zero-address ERC20 burn with zero zero-address balance");
    }
  }
  const positionTokenId = asBigint(pa.positionTokenId, "position token id");
  const positionManager = asAddress(coordinatorPositionManager, "position manager");
  const poolManager = asAddress(coordinatorPoolManager, "pool manager");
  const positionInfo = await client.readContract({
    address: positionManager,
    abi: positionReadAbi,
    functionName: "getPoolAndPositionInfo",
    args: [positionTokenId],
  }) as unknown as readonly [Record<string, unknown>, unknown];
  const positionKey = positionInfo[0];
  const keyCurrency0 = asAddress(positionKey.currency0, "pool currency0");
  const keyCurrency1 = asAddress(positionKey.currency1, "pool currency1");
  const keyFeeNumber = normalizeGenesisAbiInteger(positionKey.fee, "pool fee", 0n, 0xff_ffffn);
  const keyTickSpacingNumber = normalizeGenesisAbiInteger(positionKey.tickSpacing, "pool tick spacing", -0x80_0000n, 0x7f_ffffn);
  const keyHooks = asAddress(positionKey.hooks, "pool hooks");
  const initialize = findEvent(
    launchReceipt.logs as unknown as EventLog[],
    poolManagerEventsAbi,
    poolManager,
    "Initialize",
  );
  const ia = initialize.args;
  const initializeId = asHash(ia.id, "initialized pool id");
  const initializeCurrency0 = asAddress(ia.currency0, "initialized currency0");
  const initializeCurrency1 = asAddress(ia.currency1, "initialized currency1");
  const initializeFee = normalizeGenesisAbiInteger(ia.fee, "initialized fee", 0n, 0xff_ffffn);
  const initializeTickSpacing = normalizeGenesisAbiInteger(ia.tickSpacing, "initialized tick spacing", -0x80_0000n, 0x7f_ffffn);
  const initializeHooks = asAddress(ia.hooks, "initialized hook");
  const initializeSqrtPrice = asBigint(ia.sqrtPriceX96, "initialized sqrt price");
  const poolIdFromKey = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [keyCurrency0, keyCurrency1, keyFeeNumber, keyTickSpacingNumber, keyHooks],
  ));
  const poolStateSlot = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }],
    [poolIdFromKey, 6n],
  ));
  const packedPoolState = await client.readContract({
    address: poolManager,
    abi: poolManagerReadAbi,
    functionName: "extsload",
    args: [poolStateSlot],
  });
  const packed = BigInt(packedPoolState);
  const actualSqrtPrice = packed & ((1n << 160n) - 1n);
  const positionOwner = await client.readContract({ address: positionManager, abi: positionReadAbi, functionName: "ownerOf", args: [positionTokenId] });
  const positionLiquidity = await client.readContract({ address: positionManager, abi: positionReadAbi, functionName: "getPositionLiquidity", args: [positionTokenId] });
  const [lockPositionManager, lockTokenId, lockToken, lockVault, lockCurrency0, lockCurrency1] = await Promise.all([
    client.readContract({ address: asAddress(lock, "position lock"), abi: lockReadAbi, functionName: "positionManager" }),
    client.readContract({ address: asAddress(lock, "position lock"), abi: lockReadAbi, functionName: "tokenId" }),
    client.readContract({ address: asAddress(lock, "position lock"), abi: lockReadAbi, functionName: "genesisToken" }),
    client.readContract({ address: asAddress(lock, "position lock"), abi: lockReadAbi, functionName: "feeVault" }),
    client.readContract({ address: asAddress(lock, "position lock"), abi: lockReadAbi, functionName: "currency0" }),
    client.readContract({ address: asAddress(lock, "position lock"), abi: lockReadAbi, functionName: "currency1" }),
  ]);
  const [hookCode, lockCode] = await Promise.all([
    client.getCode({ address: asAddress(hook, "hook") }),
    client.getCode({ address: asAddress(lock, "position lock") }),
  ]);
  const hookHash = hookCode && hookCode !== "0x" ? keccak256(hookCode) : "0x";
  const lockHash = lockCode && lockCode !== "0x" ? keccak256(lockCode) : "0x";
  const hookArtifact = await runtimeArtifact("hook", config.version);
  const lockArtifact = await runtimeArtifact("lock", config.version);
  const expectedHookHash = isV2 && hookArtifact
    ? patchedRuntimeHash(hookArtifact, [poolManager, config.factory, config.coordinator, token])
    : null;
  const expectedLockHash = isV2 && lockArtifact
    ? patchedRuntimeHash(lockArtifact, [positionManager, positionTokenId, token, feeVault, "0x0000000000000000000000000000000000000000" as Address, token])
    : null;
  if (
    !equalAddress(mappedToken, token) || !equalAddress(mappedCreator, creator) || !equalAddress(mappedVault, feeVault)
    || !equalAddress(configuredCoordinator, config.coordinator)
    || !equalAddress(coordinatorFactory, config.factory)
    || !equalAddress(poolManager, config.poolManager)
    || !equalAddress(positionManager, config.positionManager)
    || !equalAddress(positionManager, coordinatorPositionManager)
    || !equalHash(poolIdFromKey, poolId)
    || !equalHash(initializeId, poolIdFromKey)
    || !equalAddress(keyCurrency0, "0x0000000000000000000000000000000000000000")
    || !equalAddress(keyCurrency1, token) || keyFeeNumber !== 10_000 || keyTickSpacingNumber !== 200
    || !equalAddress(keyHooks, hook)
    || !equalAddress(initializeCurrency0, keyCurrency0) || !equalAddress(initializeCurrency1, keyCurrency1)
    || initializeFee !== keyFeeNumber || initializeTickSpacing !== keyTickSpacingNumber
    || !equalAddress(initializeHooks, keyHooks) || initializeSqrtPrice !== config.sqrtPriceX96
    || actualSqrtPrice === 0n
    || !equalAddress(positionOwner, lock) || positionLiquidity === 0n
    || !equalAddress(lockPositionManager, positionManager) || lockTokenId !== positionTokenId
    || !equalAddress(lockToken, token) || !equalAddress(lockVault, feeVault)
    || !equalAddress(lockCurrency0, "0x0000000000000000000000000000000000000000")
    || !equalAddress(lockCurrency1, token)
    || (BigInt(hook) & 0x3fffn) !== 0x2000n
    || !hookCode || hookCode === "0x" || !lockCode || lockCode === "0x"
    || (isV2 && (!expectedHookHash || !expectedLockHash
      || !equalHash(hookHash, expectedHookHash) || !equalHash(lockHash, expectedLockHash)))
  ) invalid("Genesis PoolManager, PositionManager, hook, or permanent-lock attestation mismatch");
  if (!equalAddress(mappedToken, token) || !equalAddress(mappedCreator, creator) || !equalAddress(mappedVault, feeVault)
    || !equalAddress(configuredCoordinator, config.coordinator) || !equalAddress(coordinatorFactory, config.factory)
    || !launched || equalAddress(hook, "0x0000000000000000000000000000000000000000")
    || equalAddress(lock, "0x0000000000000000000000000000000000000000")
    || !equalAddress(lock, eventPositionLock)
    || equalHash(poolId, "0x" + "00".repeat(32))
    || tokenName !== name || tokenSymbol !== symbol || tokenLogo !== logoUri
    || (isV2 ? burned !== poolDust : burned !== GENESIS_BURN + poolDust)
    || !equalAddress(tokenCreator, creator) || creatorBalance !== 0n || !equalHash(tokenDigest, digest)
    || !equalAddress(launchRecipient, config.factory) || !equalAddress(vaultCreator, creator)
    || !equalAddress(vaultProtocol, config.protocol) || !equalAddress(vaultWeth, config.weth)
    || !equalAddress(vaultToken, token)) invalid("Genesis contract mappings or metadata do not match");
  validateGenesisLaunchAccounting({
    launchAmount,
    poolTokenAmount,
    poolDust,
    mappedTokenDust: tokenDust,
    deadBalance: burned,
    eventPositionLock,
    mappedPositionLock: asAddress(lock, "position lock"),
    version: isV2 ? "v2" : "v1",
  });

  const [deploymentBlock, launchBlock, latestBlock, recipeRows] = await Promise.all([
    client.getBlock({ blockNumber: deploymentReceipt.blockNumber }),
    client.getBlock({ blockNumber: launchReceipt.blockNumber }),
    client.getBlockNumber(),
    db.select().from(approvedGenesisRecipesTable).where(eq(approvedGenesisRecipesTable.walletAddress, creator)).limit(10),
  ]);
  if (!equalHash(deploymentReceipt.blockHash, deploymentBlock.hash)
    || !equalHash(launchReceipt.blockHash, launchBlock.hash)) {
    invalid("Genesis transaction block hash is not canonical");
  }
  requireGenesisFinality(latestBlock, deploymentReceipt.blockNumber, launchReceipt.blockNumber);
  const recipe = recipeRows.find((row: ApprovedGenesisRecipe) =>
    row.deploymentDigest && equalHash(row.deploymentDigest, digest)
    && (!row.genesisDigest || equalHash(row.genesisDigest, digest)));
  if (!recipe || recipe.tokenName !== name || recipe.symbol !== symbol || recipe.logoUri !== logoUri) {
    invalid("No approved Genesis recipe matches the on-chain identity");
  }
  return {
    version: config.version, chainId: GENESIS_CHAIN_ID, creatorWalletAddress: creator, genesisDigest: digest, tokenAddress: token,
    feeVaultAddress: feeVault, hookAddress: asAddress(hook, "hook"), positionLockAddress: asAddress(lock, "position lock"),
    poolId: String(poolId), positionTokenId: BigInt(pa.positionTokenId as bigint), tokenName: name, symbol,
    logoUri, logoCid, deploymentTxHash: deploymentTxHash.toLowerCase(), deploymentBlockNumber: deploymentReceipt.blockNumber,
    deploymentTimestamp: new Date(Number(deploymentBlock.timestamp) * 1000), launchTxHash: launchTxHash.toLowerCase(),
    deploymentBlockHash: deploymentReceipt.blockHash,
    launchBlockNumber: launchReceipt.blockNumber, launchBlockHash: launchReceipt.blockHash,
    launchTimestamp: new Date(Number(launchBlock.timestamp) * 1000),
  };
}

export async function verifyGenesisLaunch(
  deploymentTxHash: Hash,
  launchTxHash: Hash,
  version: GenesisVersion,
): Promise<VerifiedGenesisLaunch> {
  try {
    return await verifyGenesisLaunchInternal(deploymentTxHash, launchTxHash, version);
  } catch (error) {
    if (error instanceof GenesisLaunchValidationError || error instanceof GenesisLaunchInfrastructureError) throw error;
    throw new GenesisLaunchInfrastructureError("Genesis chain verification is unavailable");
  }
}

type CanonicalLaunch = Pick<VerifiedGenesisLaunch, "deploymentTxHash" | "deploymentBlockNumber" | "deploymentBlockHash" | "launchTxHash" | "launchBlockNumber" | "launchBlockHash">;

/** Re-checks receipts and block hashes at the final write boundary and when
 * serving an indexed row. This prevents serving or persisting an orphaned
 * pre-finality fork. */
export async function assertGenesisLaunchCanonical(launch: CanonicalLaunch): Promise<void> {
  try {
    const rpcUrl = process.env.GENESIS_ROBINHOOD_RPC_URL || process.env.ROBINHOOD_RPC_URL || ROBINHOOD_RPC_URL;
    const clientForVersion = createPublicClient({
      chain: { id: GENESIS_CHAIN_ID, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
      transport: http(rpcUrl),
    });
    const launchTx = await clientForVersion.getTransaction({ hash: launch.launchTxHash as Hash });
    const version = await resolveVersionForTarget(clientForVersion, launchTx.to);
    const config = genesisPublicConfig(version);
    const client = createPublicClient({
      chain: { id: GENESIS_CHAIN_ID, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } },
      transport: http(config.rpcUrl),
    });
    if (await client.getChainId() !== GENESIS_CHAIN_ID) throw new GenesisLaunchInfrastructureError("Genesis RPC is not Robinhood Chain 4663");
    const [deploymentReceipt, launchReceipt, deploymentBlock, launchBlock, latestBlock] = await Promise.all([
      client.getTransactionReceipt({ hash: launch.deploymentTxHash as Hash }),
      client.getTransactionReceipt({ hash: launch.launchTxHash as Hash }),
      client.getBlock({ blockNumber: launch.deploymentBlockNumber }),
      client.getBlock({ blockNumber: launch.launchBlockNumber }),
      client.getBlockNumber(),
    ]);
    if (deploymentReceipt.status !== "success" || launchReceipt.status !== "success"
      || deploymentReceipt.blockNumber !== launch.deploymentBlockNumber
      || launchReceipt.blockNumber !== launch.launchBlockNumber
      || !equalHash(deploymentReceipt.blockHash, launch.deploymentBlockHash)
      || !equalHash(launchReceipt.blockHash, launch.launchBlockHash)
      || !equalHash(deploymentBlock.hash, launch.deploymentBlockHash)
      || !equalHash(launchBlock.hash, launch.launchBlockHash)
      || latestBlock < launch.deploymentBlockNumber + GENESIS_FINALITY_CONFIRMATIONS
      || latestBlock < launch.launchBlockNumber + GENESIS_FINALITY_CONFIRMATIONS) {
      throw new GenesisLaunchValidationError("Indexed Genesis launch is not canonical and final");
    }
  } catch (error) {
    if (error instanceof GenesisLaunchValidationError || error instanceof GenesisLaunchInfrastructureError) throw error;
    throw new GenesisLaunchInfrastructureError("Genesis canonical-chain verification is unavailable");
  }
}

export type LiveGenesisBalances = { creatorNativeDue: bigint; creatorWethDue: bigint; creatorGenesisTokenDue: bigint };
export async function readLiveGenesisBalances(feeVaultAddress: string): Promise<LiveGenesisBalances> {
  const rpcUrl = process.env.GENESIS_ROBINHOOD_RPC_URL || process.env.ROBINHOOD_RPC_URL || ROBINHOOD_RPC_URL;
  const client = createPublicClient({
    chain: { id: GENESIS_CHAIN_ID, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl),
  });
  if (await client.getChainId() !== GENESIS_CHAIN_ID) throw new Error("Genesis RPC is not Robinhood Chain 4663");
  const [nativeDue, wethDue, tokenDue] = await Promise.all([
    client.readContract({ address: asAddress(feeVaultAddress, "fee vault"), abi: feeVaultReadAbi, functionName: "creatorNativeDue" }),
    client.readContract({ address: asAddress(feeVaultAddress, "fee vault"), abi: feeVaultReadAbi, functionName: "creatorWethDue" }),
    client.readContract({ address: asAddress(feeVaultAddress, "fee vault"), abi: feeVaultReadAbi, functionName: "creatorGenesisTokenDue" }),
  ]);
  return { creatorNativeDue: nativeDue, creatorWethDue: wethDue, creatorGenesisTokenDue: tokenDue };
}
