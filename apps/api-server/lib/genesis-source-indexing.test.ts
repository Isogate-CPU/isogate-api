import assert from "node:assert/strict";
import test from "node:test";
import { checkGenesisSourceIndexing, scannerRecordIsExact, type SourceAsset } from "./genesis-source-indexing.ts";

test("public scanner source status fails closed for missing, closed, and partial records", () => {
  assert.equal(scannerRecordIsExact({}), false);
  assert.equal(scannerRecordIsExact({ is_verified: false, is_fully_verified: false }), false);
  assert.equal(scannerRecordIsExact({ is_verified: true, is_fully_verified: false }), false);
  assert.equal(scannerRecordIsExact({ is_verified: true, is_fully_verified: true, is_partially_verified: true }), false);
  assert.equal(scannerRecordIsExact({ is_verified: true, is_fully_verified: true, is_partially_verified: false }), true);
});

test("Blockscout reader payload is parsed without an API key", async () => {
  const scannerRecord = {
    is_verified: true,
    is_fully_verified: true,
    is_partially_verified: false,
  };
  const fetcher = (async (input: string | URL | Request) => {
    if (String(input).startsWith("https://sourcify.dev/server/v2/contract/")) {
      return new Response(JSON.stringify({ match: "exact_match" }), { status: 200 });
    }
    assert.match(String(input), /^https:\/\/r\.jina\.ai\/https:\/\/robinhoodchain\.blockscout\.com\/api\/v2\/smart-contracts\//);
    return new Response(`Title: \n\nURL Source: scanner\n\nMarkdown Content:\n${JSON.stringify(scannerRecord)}`, { status: 200 });
  }) as typeof fetch;
  const result = await checkGenesisSourceIndexing(launch, fetcher, {
    asset,
    scanners: [["Robinhood Blockscout", "https://r.jina.ai/https://robinhoodchain.blockscout.com"]],
  });
  assert.equal(result.status, "indexed");
});

const asset: SourceAsset = {
  compilerVersion: "0.8.30+commit.73712a01",
  standardJsonInput: { language: "Solidity", sources: {}, settings: {} },
  tokenContractIdentifier: "Token.sol:Token",
  hookContractIdentifier: "Hook.sol:Hook",
};
const launch = {
  version: "v2" as const,
  tokenAddress: "0x0000000000000000000000000000000000000001",
  hookAddress: "0x0000000000000000000000000000000000000002",
  deploymentTxHash: `0x${"11".repeat(32)}`,
  launchTxHash: `0x${"22".repeat(32)}`,
};

function indexedFetcher(scannerFullyVerified: boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/server/v2/contract/")) {
      return new Response(JSON.stringify({ match: "exact_match" }), { status: 200 });
    }
    if (url.includes("/api/v2/smart-contracts/")) {
      return new Response(JSON.stringify({
        is_verified: true,
        is_fully_verified: scannerFullyVerified,
        is_partially_verified: !scannerFullyVerified,
      }), { status: 200 });
    }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
}

test("normal reconciliation remains pending until token and hook are fully scanner-indexed", async () => {
  const scanners = [["audit", "https://scanner.example"]] as const;
  const pending = await checkGenesisSourceIndexing(launch, indexedFetcher(false), { asset, scanners });
  assert.equal(pending.status, "pending_indexing");
  assert.equal(pending.onChain, "verified");
  assert.deepEqual(pending.sourcify, { token: "exact_match", hook: "exact_match" });

  const complete = await checkGenesisSourceIndexing(launch, indexedFetcher(true), { asset, scanners });
  assert.equal(complete.status, "indexed");
  assert.ok(complete.scanners.every((scanner) => scanner.token === "exact_match" && scanner.hook === "exact_match"));
});

test("new legacy v1 reconciliation cannot bypass source indexing", async () => {
  await assert.rejects(() => checkGenesisSourceIndexing({ ...launch, version: "v1" }, indexedFetcher(true), {
    asset,
    scanners: [],
  }), /v1 reconciliation is not source-indexing supported/);
});