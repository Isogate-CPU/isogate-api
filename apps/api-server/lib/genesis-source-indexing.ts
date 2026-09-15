import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";

const CHAIN_ID = 4663;
const SOURCIFY_BASE = "https://sourcify.dev/server/v2";
const DEFAULT_SCANNERS = [
  ["Robinhood Blockscout", "https://r.jina.ai/https://robinhoodchain.blockscout.com"],
] as const;

type Json = Record<string, any>;
export type SourceAsset = {
  compilerVersion: string;
  standardJsonInput: Json;
  tokenContractIdentifier: string;
  hookContractIdentifier: string;
};
export type SourceIndexingStatus = {
  status: "pending_indexing" | "indexed";
  onChain: "verified";
  sourcify: { token: "pending" | "exact_match"; hook: "pending" | "exact_match" };
  scanners: { name: string; token: "pending" | "exact_match"; hook: "pending" | "exact_match" }[];
};

export function scannerRecordIsExact(record: Json): boolean {
  return record.is_verified === true
    && record.is_fully_verified === true
    && record.is_partially_verified !== true;
}

async function sourceAsset(): Promise<SourceAsset> {
  const path = fileURLToPath(new URL("./runtime-assets/genesis-v2-source.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as SourceAsset;
}

async function sourcifyExact(address: Address, fetcher: typeof fetch): Promise<boolean> {
  const response = await fetcher(`${SOURCIFY_BASE}/contract/${CHAIN_ID}/${address}`, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    cache: "no-store",
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Sourcify lookup failed (${response.status})`);
  return (await response.json() as Json).match === "exact_match";
}

async function submitSourcify(address: Address, contractIdentifier: string, creationTransactionHash: string, asset: SourceAsset, fetcher: typeof fetch) {
  const response = await fetcher(`${SOURCIFY_BASE}/verify/${CHAIN_ID}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stdJsonInput: asset.standardJsonInput,
      compilerVersion: asset.compilerVersion,
      contractIdentifier,
      creationTransactionHash,
    }),
  });
  const result = await response.json() as Json;
  if (!response.ok && result.customCode !== "duplicate_verification_request") {
    throw new Error(`Sourcify submission failed (${response.status})`);
  }
}

function scannerConfig(): readonly (readonly [string, string])[] {
  const configured = process.env.GENESIS_PUBLIC_SCANNERS;
  if (!configured) return DEFAULT_SCANNERS;
  return configured.split(",").map((entry) => {
    const [name, ...url] = entry.split("=");
    if (!name || url.length === 0) throw new Error("GENESIS_PUBLIC_SCANNERS must use name=https://host entries");
    return [name.trim(), url.join("=").trim()] as const;
  });
}

async function scannerExact(baseUrl: string, address: Address, fetcher: typeof fetch): Promise<boolean> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/v2/smart-contracts/${address}`;
  const response = await fetcher(endpoint, {
    headers: { accept: "application/json", "cache-control": "no-cache", pragma: "no-cache" },
    cache: "no-store",
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Scanner lookup failed (${response.status})`);
  if (baseUrl.startsWith("https://r.jina.ai/")) {
    const body = await response.text();
    const marker = "Markdown Content:\n";
    const markerIndex = body.indexOf(marker);
    if (markerIndex < 0) throw new Error("Scanner reader returned an invalid response");
    return scannerRecordIsExact(JSON.parse(body.slice(markerIndex + marker.length).trim()) as Json);
  }
  return scannerRecordIsExact(await response.json() as Json);
}

export async function checkGenesisSourceIndexing(
  launch: { version: "v1" | "v2"; tokenAddress: string; hookAddress: string; deploymentTxHash: string; launchTxHash: string },
  fetcher: typeof fetch = fetch,
  options: { asset?: SourceAsset; scanners?: readonly (readonly [string, string])[] } = {},
): Promise<SourceIndexingStatus> {
  if (launch.version !== "v2") throw new Error("New Genesis v1 reconciliation is not source-indexing supported");
  const asset = options.asset ?? await sourceAsset();
  const token = launch.tokenAddress as Address;
  const hook = launch.hookAddress as Address;
  let [tokenExact, hookExact] = await Promise.all([sourcifyExact(token, fetcher), sourcifyExact(hook, fetcher)]);
  await Promise.all([
    tokenExact ? undefined : submitSourcify(token, asset.tokenContractIdentifier, launch.deploymentTxHash, asset, fetcher),
    hookExact ? undefined : submitSourcify(hook, asset.hookContractIdentifier, launch.launchTxHash, asset, fetcher),
  ]);
  if (!tokenExact || !hookExact) {
    [tokenExact, hookExact] = await Promise.all([sourcifyExact(token, fetcher), sourcifyExact(hook, fetcher)]);
  }
  const scanners = await Promise.all((options.scanners ?? scannerConfig()).map(async ([name, baseUrl]) => {
    try {
      const [tokenIndexed, hookIndexed] = await Promise.all([
        scannerExact(baseUrl, token, fetcher),
        scannerExact(baseUrl, hook, fetcher),
      ]);
      return { name, token: tokenIndexed ? "exact_match" as const : "pending" as const, hook: hookIndexed ? "exact_match" as const : "pending" as const };
    } catch {
      return { name, token: "pending" as const, hook: "pending" as const };
    }
  }));
  const indexed = tokenExact && hookExact && scanners.every((scanner) => scanner.token === "exact_match" && scanner.hook === "exact_match");
  return {
    status: indexed ? "indexed" : "pending_indexing",
    onChain: "verified",
    sourcify: { token: tokenExact ? "exact_match" : "pending", hook: hookExact ? "exact_match" : "pending" },
    scanners,
  };
}