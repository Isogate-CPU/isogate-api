import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { count, desc, eq, or } from "drizzle-orm";
import { getAddress } from "viem";
import {
  db,
  genesisLaunchesTable,
} from "@isogate/db";
import {
  GetGenesisLaunchParams,
  GetGenesisLaunchResponse,
  ListCreatorGenesisLaunchesParams,
  ListCreatorGenesisLaunchesResponse,
  ListGenesisLaunchesQueryParams,
  ListGenesisLaunchesResponse,
  ReconcileGenesisLaunchBody,
  ReconcileGenesisLaunchResponse,
} from "@isogate/api-zod";
import {
  BLOCKSCOUT_BASE_URL,
  genesisLaunchErrorStatus,
  assertGenesisLaunchCanonical,
  readLiveGenesisBalances,
  verifyGenesisLaunch,
} from "../lib/genesis-launch-reconciliation";
import { checkGenesisSourceIndexing } from "../lib/genesis-source-indexing";

const router: IRouter = Router();

function explorer(address: string, deploymentTxHash: string, launchTxHash: string) {
  return {
    token: `${BLOCKSCOUT_BASE_URL}/address/${address}`,
    deploymentTx: `${BLOCKSCOUT_BASE_URL}/tx/${deploymentTxHash}`,
    launchTx: `${BLOCKSCOUT_BASE_URL}/tx/${launchTxHash}`,
  };
}

async function publicLaunchResponse(row: typeof genesisLaunchesTable.$inferSelect) {
  // A failed RPC read is intentionally propagated. Due balances are live chain
  // state and must never be represented by a misleading zero.
  await assertGenesisLaunchCanonical(row);
  const balances = await readLiveGenesisBalances(row.feeVaultAddress);
  return {
    version: row.version,
    chainId: row.chainId,
    creatorWalletAddress: row.creatorWalletAddress,
    genesisDigest: row.genesisDigest,
    tokenAddress: row.tokenAddress,
    feeVaultAddress: row.feeVaultAddress,
    hookAddress: row.hookAddress,
    positionLockAddress: row.positionLockAddress,
    poolId: row.poolId,
    positionTokenId: row.positionTokenId.toString(),
    tokenName: row.tokenName,
    symbol: row.symbol,
    logoUri: row.logoUri,
    logoCid: row.logoCid,
    deploymentTxHash: row.deploymentTxHash,
    deploymentBlockNumber: row.deploymentBlockNumber.toString(),
    deploymentBlockHash: row.deploymentBlockHash,
    deploymentTimestamp: row.deploymentTimestamp.toISOString(),
    launchTxHash: row.launchTxHash,
    launchBlockNumber: row.launchBlockNumber.toString(),
    launchBlockHash: row.launchBlockHash,
    launchTimestamp: row.launchTimestamp.toISOString(),
    creatorNativeDue: balances.creatorNativeDue.toString(),
    creatorWethDue: balances.creatorWethDue.toString(),
    creatorGenesisTokenDue: balances.creatorGenesisTokenDue.toString(),
    explorer: explorer(row.tokenAddress, row.deploymentTxHash, row.launchTxHash),
  };
}

router.post("/genesis/launches/reconcile", async (req, res): Promise<void> => {
  const parsed = ReconcileGenesisLaunchBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issueCount: parsed.error.issues.length }, "Genesis launch reconciliation rejected");
    res.status(400).json({ error: "Provide valid deployment and launch transaction hashes." });
    return;
  }
  try {
    const verified = await verifyGenesisLaunch(
      parsed.data.deploymentTxHash as `0x${string}`,
      parsed.data.launchTxHash as `0x${string}`,
      (parsed.data as typeof parsed.data & { version: "v1" | "v2" }).version,
    );
    if (verified.version !== "v2") {
      res.status(409).json({ error: "Legacy Genesis v1 launches cannot be newly reconciled." });
      return;
    }
    const sourceIndexing = await checkGenesisSourceIndexing(verified);
    if (sourceIndexing.status !== "indexed") {
      res.status(202).json(sourceIndexing);
      return;
    }
    const [existing] = await db.select().from(genesisLaunchesTable).where(or(
      eq(genesisLaunchesTable.tokenAddress, verified.tokenAddress),
      eq(genesisLaunchesTable.launchTxHash, verified.launchTxHash),
    )).limit(1);
    if (existing) {
      if (existing.tokenAddress !== verified.tokenAddress
        || existing.launchTxHash !== verified.launchTxHash
        || existing.deploymentTxHash !== verified.deploymentTxHash) {
        res.status(409).json({ error: "A conflicting launch is already indexed for this token or transaction." });
        return;
      }
      res.json(ReconcileGenesisLaunchResponse.parse(await publicLaunchResponse(existing)));
      return;
    }
    // Re-check canonical block hashes at the write boundary, after every
    // contract and recipe validation has completed.
    await assertGenesisLaunchCanonical(verified);
    const [inserted] = await db.insert(genesisLaunchesTable).values({
      id: randomUUID(),
      version: verified.version,
      chainId: verified.chainId,
      creatorWalletAddress: verified.creatorWalletAddress,
      genesisDigest: verified.genesisDigest,
      tokenAddress: verified.tokenAddress,
      feeVaultAddress: verified.feeVaultAddress,
      hookAddress: verified.hookAddress,
      positionLockAddress: verified.positionLockAddress,
      poolId: verified.poolId,
      positionTokenId: verified.positionTokenId,
      tokenName: verified.tokenName,
      symbol: verified.symbol,
      logoUri: verified.logoUri,
      logoCid: verified.logoCid,
      deploymentTxHash: verified.deploymentTxHash,
      deploymentBlockNumber: verified.deploymentBlockNumber,
      deploymentBlockHash: verified.deploymentBlockHash,
      deploymentTimestamp: verified.deploymentTimestamp,
      launchTxHash: verified.launchTxHash,
      launchBlockNumber: verified.launchBlockNumber,
      launchBlockHash: verified.launchBlockHash,
      launchTimestamp: verified.launchTimestamp,
    }).returning();
    if (!inserted) throw new Error("Genesis launch index insert returned no row");
    req.log.info({ tokenAddress: verified.tokenAddress, launchTxHash: verified.launchTxHash }, "Genesis launch reconciled");
    res.json(ReconcileGenesisLaunchResponse.parse(await publicLaunchResponse(inserted)));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "Genesis launch reconciliation failed closed");
    if (genesisLaunchErrorStatus(error) === 409) {
      res.status(409).json({ error: "The supplied transactions do not describe a valid Genesis launch." });
      return;
    }
    res.status(502).json({ error: "Genesis chain verification is unavailable or failed." });
  }
});

async function listLaunches(
  req: { log: { error: (context: object, message: string) => void } },
  page: number,
  limit: number,
  creatorWalletAddress?: string,
) {
  const where = creatorWalletAddress
    ? eq(genesisLaunchesTable.creatorWalletAddress, creatorWalletAddress)
    : undefined;
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(genesisLaunchesTable).where(where)
      .orderBy(desc(genesisLaunchesTable.launchTimestamp), desc(genesisLaunchesTable.launchTxHash))
      .limit(limit).offset((page - 1) * limit),
    db.select({ total: count() }).from(genesisLaunchesTable).where(where),
  ]);
  const items = await Promise.all(rows.map(publicLaunchResponse));
  return { items, page, limit, total: Number(total) };
}

router.get("/genesis/launches", async (req, res): Promise<void> => {
  const parsed = ListGenesisLaunchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid pagination parameters." });
    return;
  }
  try {
    res.json(ListGenesisLaunchesResponse.parse(await listLaunches(req, parsed.data.page, parsed.data.limit)));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "Genesis launch list chain read failed");
    res.status(502).json({ error: "Genesis fee-vault data is unavailable." });
  }
});

router.get("/genesis/launches/:tokenAddress", async (req, res): Promise<void> => {
  const parsed = GetGenesisLaunchParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide a valid token address." });
    return;
  }
  let tokenAddress: string;
  try {
    tokenAddress = getAddress(parsed.data.tokenAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid token address." });
    return;
  }
  const [row] = await db.select().from(genesisLaunchesTable)
    .where(eq(genesisLaunchesTable.tokenAddress, tokenAddress)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Genesis launch not found." });
    return;
  }
  try {
    res.json(GetGenesisLaunchResponse.parse(await publicLaunchResponse(row)));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "Genesis launch detail chain read failed");
    res.status(502).json({ error: "Genesis fee-vault data is unavailable." });
  }
});

router.get("/genesis/creators/:walletAddress/launches", async (req, res): Promise<void> => {
  const params = ListCreatorGenesisLaunchesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Provide a valid creator wallet address." });
    return;
  }
  let walletAddress: string;
  try {
    walletAddress = getAddress(params.data.walletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid creator wallet address." });
    return;
  }
  try {
    res.json(ListCreatorGenesisLaunchesResponse.parse(
      await listLaunches(req, 1, 25, walletAddress),
    ));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "Creator Genesis launch list chain read failed");
    res.status(502).json({ error: "Genesis fee-vault data is unavailable." });
  }
});

export default router;