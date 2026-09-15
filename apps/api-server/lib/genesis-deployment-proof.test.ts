import assert from "node:assert/strict";
import test from "node:test";
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  stringToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  GENESIS_CHAIN_ID,
  GENESIS_IDENTITY_TYPES,
  GENESIS_PROTOCOL_NAME,
  GENESIS_PROTOCOL_VERSION,
  genesisIdentityDigest,
  type DeploymentProofPayload,
} from "./genesis-deployment-proof.ts";

test("Genesis IdentityProof digest matches Solidity EIP-712 encoding", async () => {
  const registry = "0x1111111111111111111111111111111111111111" as const;
  const proof: DeploymentProofPayload = {
    providerJobRef: `0x${"01".repeat(32)}`,
    providerRef: `0x${"02".repeat(32)}`,
    creator: "0x2222222222222222222222222222222222222222",
    factory: "0x3333333333333333333333333333333333333333",
    protocol: "0x4444444444444444444444444444444444444444",
    name: "Genesis",
    symbol: "GEN",
    descriptionHash: `0x${"05".repeat(32)}`,
    engineHash: `0x${"06".repeat(32)}`,
    seedHash: `0x${"07".repeat(32)}`,
    cpuDigest: `0x${"08".repeat(32)}`,
    imageDigest: `0x${"09".repeat(32)}`,
    logoUri: "ipfs://QmYwAPJzv5CZsnAzt8auVZRn7gXn6R7S7f4jN8f2J7h3hM",
    expiry: 1_800_000_000n,
    nonce: 123n,
  };
  const domainTypeHash = keccak256(stringToHex(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ));
  const domain = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [
      domainTypeHash,
      keccak256(stringToHex(GENESIS_PROTOCOL_NAME)),
      keccak256(stringToHex(GENESIS_PROTOCOL_VERSION)),
      BigInt(GENESIS_CHAIN_ID),
      registry,
    ],
  ));
  const typeHash = keccak256(stringToHex(
    "IdentityProof(bytes32 providerJobRef,bytes32 providerRef,address creator,address factory,address protocol,string name,string symbol,bytes32 descriptionHash,bytes32 engineHash,bytes32 seedHash,bytes32 cpuDigest,bytes32 imageDigest,string logoUri,uint256 expiry,uint256 nonce)",
  ));
  const struct = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" },
      { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
    ],
    [
      typeHash, proof.providerJobRef, proof.providerRef, proof.creator, proof.factory, proof.protocol,
      keccak256(stringToHex(proof.name)), keccak256(stringToHex(proof.symbol)), proof.descriptionHash,
      proof.engineHash, proof.seedHash, proof.cpuDigest, proof.imageDigest, keccak256(stringToHex(proof.logoUri)),
      proof.expiry, proof.nonce,
    ],
  ));
  const independent = keccak256(concatHex(["0x1901", domain, struct]));
  assert.equal(genesisIdentityDigest({ registry }, proof), independent);

  const account = privateKeyToAccount(`0x${"aa".repeat(32)}` as Hex);
  const signature = await account.signTypedData({
    domain: { name: GENESIS_PROTOCOL_NAME, version: GENESIS_PROTOCOL_VERSION, chainId: GENESIS_CHAIN_ID, verifyingContract: registry },
    types: GENESIS_IDENTITY_TYPES,
    primaryType: "IdentityProof",
    message: proof,
  });
  assert.equal(await recoverAddress({ hash: independent, signature }), account.address);
});