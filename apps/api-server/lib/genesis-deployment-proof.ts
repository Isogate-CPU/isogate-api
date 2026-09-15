import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { ApprovedGenesisRecipe } from "@isogate/db";
import { encodeGenesisPngWithDigest } from "./genesis-png.ts";

export const GENESIS_CHAIN_ID = 4663;
export const GENESIS_VERSION = "v2" as const;
export const GENESIS_PROTOCOL_NAME = "Isogate Genesis Identity";
export const GENESIS_PROTOCOL_VERSION = "1";
export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com/";

const OFFICIAL = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  permissionMask: 1n << 13n,
  fee: 10_000n,
  tickSpacing: 200n,
  sqrtPrice: 34_500n * (1n << 96n),
} as const;

const registryAbi = [
  { name: "verifier", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const factoryAbi = [
  { name: "identityRegistry", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "protocol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "launchCoordinator", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const coordinatorAbi = [
  { name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "poolManager", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "positionManager", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "permit2", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "weth9", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "HOOK_PERMISSION_MASK", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }] },
  { name: "LP_FEE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { name: "TICK_SPACING", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { name: "INITIAL_SQRT_PRICE_X96", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint160" }] },
] as const;

const positionAbi = [
  { name: "poolManager", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "WETH9", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

type DeploymentConfig = {
  version: typeof GENESIS_VERSION;
  registry: Address;
  factory: Address;
  coordinator: Address;
  protocol: Address;
  verifier: Address;
  rpcUrl: string;
  official: typeof OFFICIAL;
};

export type DeploymentProofPayload = {
  providerJobRef: Hex;
  providerRef: Hex;
  creator: Address;
  factory: Address;
  protocol: Address;
  name: string;
  symbol: string;
  descriptionHash: Hex;
  engineHash: Hex;
  seedHash: Hex;
  cpuDigest: Hex;
  imageDigest: Hex;
  logoUri: string;
  expiry: bigint;
  nonce: bigint;
};

export const GENESIS_IDENTITY_TYPES = {
  IdentityProof: [
    { name: "providerJobRef", type: "bytes32" },
    { name: "providerRef", type: "bytes32" },
    { name: "creator", type: "address" },
    { name: "factory", type: "address" },
    { name: "protocol", type: "address" },
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "descriptionHash", type: "bytes32" },
    { name: "engineHash", type: "bytes32" },
    { name: "seedHash", type: "bytes32" },
    { name: "cpuDigest", type: "bytes32" },
    { name: "imageDigest", type: "bytes32" },
    { name: "logoUri", type: "string" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function genesisIdentityDigest(
  config: Pick<DeploymentConfig, "registry">,
  proof: DeploymentProofPayload,
): Hex {
  return hashTypedData({
    domain: {
      name: GENESIS_PROTOCOL_NAME,
      version: GENESIS_PROTOCOL_VERSION,
      chainId: GENESIS_CHAIN_ID,
      verifyingContract: config.registry,
    },
    types: GENESIS_IDENTITY_TYPES,
    primaryType: "IdentityProof",
    message: proof,
  });
}

export type SignedDeploymentProof = {
  proof: DeploymentProofPayload;
  signature: Hex;
  digest: Hex;
  verifier: Address;
  config: DeploymentConfig;
  issuedAt: Date;
  expiry: Date;
};

function configuredAddress(name: string): Address {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is not configured`);
  return value as Address;
}

export function deploymentConfig(): DeploymentConfig {
  const rpcUrl = process.env.GENESIS_ROBINHOOD_RPC_URL
    || process.env.ROBINHOOD_RPC_URL
    || ROBINHOOD_RPC_URL;
  const key = process.env.GENESIS_VERIFIER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("GENESIS_VERIFIER_PRIVATE_KEY is not configured");
  const account = privateKeyToAccount(key as Hex);
  return {
    version: GENESIS_VERSION,
    // Legacy GENESIS_* addresses remain available to reconciliation/indexing,
    // but proof issuance must target explicit v2 infrastructure.
    registry: configuredAddress("GENESIS_V2_REGISTRY_ADDRESS"),
    factory: configuredAddress("GENESIS_V2_FACTORY_ADDRESS"),
    coordinator: configuredAddress("GENESIS_V2_COORDINATOR_ADDRESS"),
    protocol: configuredAddress("GENESIS_V2_PROTOCOL_ADDRESS"),
    verifier: account.address,
    rpcUrl,
    official: OFFICIAL,
  };
}

function canonicalLogoUri(uri: string): boolean {
  if (!uri.startsWith("ipfs://")) return false;
  const cid = uri.slice(7);
  if (cid.startsWith("Qm")) return cid.length === 46 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(cid);
  return /^b[a-z2-7]{49,127}$/.test(cid);
}

const equalAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Verify every immutable deployment dependency before any attestation is signed. */
export async function verifyGenesisDeploymentConfig(): Promise<DeploymentConfig> {
  const config = deploymentConfig();
  const client = createPublicClient({
    chain: { id: GENESIS_CHAIN_ID, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } },
    transport: http(config.rpcUrl),
  });
  const addresses = [config.registry, config.factory, config.coordinator, OFFICIAL.poolManager, OFFICIAL.positionManager, OFFICIAL.permit2, OFFICIAL.weth] as Address[];
  const code = await Promise.all(addresses.map((address) => client.getCode({ address })));
  if (code.some((value) => !value || value === "0x")) throw new Error("Genesis deployment dependency has no code");
  const verifier = await client.readContract({ address: config.registry, abi: registryAbi, functionName: "verifier" });
  const [identityRegistry, protocol, launchCoordinator] = await Promise.all([
    client.readContract({ address: config.factory, abi: factoryAbi, functionName: "identityRegistry" }),
    client.readContract({ address: config.factory, abi: factoryAbi, functionName: "protocol" }),
    client.readContract({ address: config.factory, abi: factoryAbi, functionName: "launchCoordinator" }),
  ]);
  if (!equalAddress(verifier, config.verifier)
    || !equalAddress(identityRegistry, config.registry)
    || !equalAddress(protocol, config.protocol)
    || !equalAddress(launchCoordinator, config.coordinator)) throw new Error("Genesis registry/factory wiring mismatch");
  const values = await Promise.all([
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "factory" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "poolManager" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "positionManager" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "permit2" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "weth9" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "HOOK_PERMISSION_MASK" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "LP_FEE" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "TICK_SPACING" }),
    client.readContract({ address: config.coordinator, abi: coordinatorAbi, functionName: "INITIAL_SQRT_PRICE_X96" }),
  ]);
  if (!equalAddress(values[0], config.factory)
    || !equalAddress(values[1], OFFICIAL.poolManager)
    || !equalAddress(values[2], OFFICIAL.positionManager)
    || !equalAddress(values[3], OFFICIAL.permit2)
    || !equalAddress(values[4], OFFICIAL.weth)
    || BigInt(values[5]) !== OFFICIAL.permissionMask || BigInt(values[6]) !== OFFICIAL.fee
    || BigInt(values[7]) !== OFFICIAL.tickSpacing || BigInt(values[8]) !== OFFICIAL.sqrtPrice) throw new Error("Genesis coordinator configuration mismatch");
  const positionPool = await client.readContract({ address: OFFICIAL.positionManager, abi: positionAbi, functionName: "poolManager" });
  const positionWeth = await client.readContract({ address: OFFICIAL.positionManager, abi: positionAbi, functionName: "WETH9" });
  if (!equalAddress(positionPool, OFFICIAL.poolManager) || !equalAddress(positionWeth, OFFICIAL.weth)) throw new Error("Genesis position manager wiring mismatch");
  return config;
}

function bytes32(value: string): Hex {
  return (`0x${value.replace(/^0x/, "")}`) as Hex;
}

export async function issueGenesisDeploymentProof(recipe: ApprovedGenesisRecipe): Promise<SignedDeploymentProof> {
  if (recipe.uploadStatus !== "uploaded" || !recipe.uploadedAt || !recipe.ipfsCid || !recipe.logoUri || !canonicalLogoUri(recipe.logoUri)
    || recipe.logoUri !== `ipfs://${recipe.ipfsCid}` || !/^[a-f0-9]{64}$/.test(recipe.pngDigest)
    || encodeGenesisPngWithDigest(recipe.pixels).pngDigest !== recipe.pngDigest) throw new Error("Approved recipe artifact is not immutable and uploaded");
  const config = await verifyGenesisDeploymentConfig();
  const account = privateKeyToAccount(process.env.GENESIS_VERIFIER_PRIVATE_KEY as Hex);
  const issuedAt = new Date();
  const expiry = new Date(issuedAt.getTime() + 5 * 60_000);
  const canonical = {
    providerJobRef: bytes32(keccak256(stringToHex(recipe.providerJobId))),
    providerRef: bytes32(keccak256(stringToHex(recipe.providerId))),
    creator: recipe.walletAddress as Address,
    factory: config.factory,
    protocol: config.protocol,
    name: recipe.tokenName,
    symbol: recipe.symbol,
    descriptionHash: keccak256(stringToHex(recipe.description)),
    engineHash: keccak256(stringToHex(recipe.engineVersion)),
    seedHash: keccak256(toHex(Uint8Array.from(recipe.seed))),
    cpuDigest: bytes32(recipe.cpuDigest),
    imageDigest: bytes32(recipe.imageDigest),
    logoUri: recipe.logoUri,
    expiry: BigInt(Math.floor(expiry.getTime() / 1000)),
    nonce: BigInt(`0x${randomBytes(32).toString("hex")}`),
  } satisfies DeploymentProofPayload;
  const signature = await account.signTypedData({
    domain: { name: GENESIS_PROTOCOL_NAME, version: GENESIS_PROTOCOL_VERSION, chainId: GENESIS_CHAIN_ID, verifyingContract: config.registry },
    types: GENESIS_IDENTITY_TYPES,
    primaryType: "IdentityProof",
    message: canonical,
  });
  const digest = genesisIdentityDigest(config, canonical);
  return { proof: canonical, signature, digest: digest as Hex, verifier: config.verifier, config, issuedAt, expiry };
}