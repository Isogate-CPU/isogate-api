import { createHash, randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  computeProvidersTable,
  providerJobsTable,
  verificationEventsTable,
} from "@isogate/db";
import {
  CreateVerificationBody,
  CreateVerificationResponse,
  GetJobReceiptParams,
  GetJobReceiptResponse,
  GetNetworkJobParams,
  GetNetworkJobResponse,
  GetNetworkSummaryResponse,
  ListNetworkJobsQueryParams,
  ListNetworkJobsResponse,
  ListNetworkProvidersResponse,
  ListVerificationsResponse,
} from "@isogate/api-zod";
import {
  canonicalProviderJobDigest,
  canonicalProviderJobDigestAlgorithm,
  canonicalProviderJobResult,
  type ProviderWorkload,
} from "../lib/provider-job-result";

const router: IRouter = Router();

type ProviderRow = typeof computeProvidersTable.$inferSelect;
type JobRow = typeof providerJobsTable.$inferSelect;

function providerResponse(row: ProviderRow) {
  const online = row.status === "online" && Date.now() - row.lastSeenAt.getTime() < 90_000;
  return {
    id: row.id,
    status: online ? "online" as const : "offline" as const,
    reportDigest: row.reportDigest,
    cpuVendor: row.cpuVendor,
    cpuModel: row.cpuModel,
    architecture: row.architecture,
    logicalProcessors: row.logicalProcessors,
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    walletAddress: row.walletAddress,
    walletBoundAt: row.walletBoundAt?.toISOString() ?? null,
  };
}

function jobResponse(row: JobRow) {
  return {
    id: row.id,
    providerId: row.providerId,
    agentId: row.agentId,
    agentPolicyHash: row.agentPolicyHash,
    workload: row.workload as "cpu_replay" | "cpu_art_rgb565",
    creatorWalletAddress: row.creatorWalletAddress,
    verificationStatus: row.verificationStatus as "queued" | "verified" | "mismatch" | "failed" | "expired",
    creatorApprovedAt: row.creatorApprovedAt?.toISOString() ?? null,
    status: row.status as "queued" | "assigned" | "completed" | "rejected",
    inputs: row.inputs as number[],
    cycles: row.cycles,
    createdAt: row.createdAt.toISOString(),
    assignedAt: row.assignedAt?.toISOString() ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    attemptCount: row.attemptCount,
    completedAt: row.completedAt?.toISOString() ?? null,
    result: row.result ?? null,
  };
}

function publicJobResponse(row: JobRow) {
  return {
    id: row.id,
    providerId: row.providerId,
    status: row.status as "completed" | "rejected",
    cycles: row.cycles,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function verificationResponse(row: typeof verificationEventsTable.$inferSelect) {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status as "match" | "mismatch",
    digest: row.digest,
    checkedAt: row.checkedAt.toISOString(),
  };
}

router.get("/network/summary", async (_req, res): Promise<void> => {
  const [providers, jobs] = await Promise.all([
    db.select().from(computeProvidersTable),
    db.select({ status: providerJobsTable.status }).from(providerJobsTable),
  ]);
  const counts = { queued: 0, assigned: 0, completed: 0, rejected: 0 };
  for (const job of jobs) {
    if (job.status in counts) {
      counts[job.status as keyof typeof counts] += 1;
    }
  }
  const response = {
    providerCount: providers.length,
    onlineProviderCount: providers.filter((provider) =>
      provider.status === "online" && Date.now() - provider.lastSeenAt.getTime() < 90_000
    ).length,
    jobs: counts,
    totalVerifiedJobs: counts.completed,
  };
  res.json(GetNetworkSummaryResponse.parse(response));
});

router.get("/network/providers", async (_req, res): Promise<void> => {
  const providers = await db.select().from(computeProvidersTable)
    .orderBy(desc(computeProvidersTable.registeredAt))
    .limit(100);
  res.json(ListNetworkProvidersResponse.parse(providers.map(providerResponse)));
});

router.get("/network/jobs", async (req, res): Promise<void> => {
  const query = ListNetworkJobsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const status = query.data.status === "completed" || query.data.status === "rejected"
    ? query.data.status
    : undefined;
  const jobs = status
    ? await db.select().from(providerJobsTable)
      .where(eq(providerJobsTable.status, status))
      .orderBy(desc(providerJobsTable.createdAt))
      .limit(100)
    : await db.select().from(providerJobsTable)
      .where(sql`${providerJobsTable.status} IN ('completed', 'rejected')`)
      .orderBy(desc(providerJobsTable.createdAt))
      .limit(100);
  res.json(ListNetworkJobsResponse.parse(jobs.map(publicJobResponse)));
});

router.get("/network/jobs/:jobId", async (req, res): Promise<void> => {
  const params = GetNetworkJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const [job] = await db.select().from(providerJobsTable)
    .where(eq(providerJobsTable.id, params.data.jobId))
    .limit(1);
  if (!job || (job.status !== "completed" && job.status !== "rejected")) {
    res.status(404).json({ error: "Resource not found." });
    return;
  }
  res.json(GetNetworkJobResponse.parse(publicJobResponse(job)));
});

router.get("/receipts/:jobId", async (req, res): Promise<void> => {
  const params = GetJobReceiptParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const [job] = await db.select().from(providerJobsTable)
    .where(eq(providerJobsTable.id, params.data.jobId))
    .limit(1);
  if (!job || job.status !== "completed" || !job.result || !job.digest || !job.completedAt) {
    res.status(404).json({ error: "Resource not found." });
    return;
  }
  const result = job.result as { engine: string };
  const receiptId = createHash("sha256")
    .update(`${job.id}:${job.digest}:${job.agentId ?? ""}:${job.agentPolicyHash ?? ""}:${job.agentPolicyVersion ?? ""}:${job.agentOwnerWalletAddress ?? ""}`)
    .digest("hex");
  const receipt = {
    receiptId,
    jobId: job.id,
    providerId: job.providerId,
    agentId: job.agentId,
    agentPolicyHash: job.agentPolicyHash,
    agentPolicyVersion: job.agentPolicyVersion,
    agentOwnerWalletAddress: job.agentOwnerWalletAddress,
    engine: result.engine,
    digestAlgorithm: canonicalProviderJobDigestAlgorithm(),
    resultDigest: job.digest,
    inputs: job.inputs as number[],
    cycles: job.cycles,
    createdAt: job.createdAt.toISOString(),
    assignedAt: job.assignedAt?.toISOString() ?? null,
    completedAt: job.completedAt.toISOString(),
    verificationMethod: "server-canonical-recomputation" as const,
    verificationStatus: "accepted" as const,
  };
  res.json(GetJobReceiptResponse.parse(receipt));
});

router.post("/verifications", async (req, res): Promise<void> => {
  const body = CreateVerificationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const [job] = await db.select().from(providerJobsTable)
    .where(eq(providerJobsTable.id, body.data.jobId))
    .limit(1);
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Resource not found." });
    return;
  }
  const expected = canonicalProviderJobResult({
    workload: job.workload as ProviderWorkload,
    inputs: job.inputs as number[],
    cycles: job.cycles,
  });
  const expectedDigest = canonicalProviderJobDigest(expected);
  const status = job.digest === expectedDigest ? "match" : "mismatch";
  const [event] = await db.insert(verificationEventsTable).values({
    id: randomUUID(),
    jobId: job.id,
    status,
    digest: expectedDigest,
  }).returning();
  req.log.info({ jobId: job.id, status }, "Canonical verification recorded");
  res.status(201).json(CreateVerificationResponse.parse(verificationResponse(event)));
});

router.get("/verifications", async (_req, res): Promise<void> => {
  const events = await db.select().from(verificationEventsTable)
    .orderBy(desc(verificationEventsTable.checkedAt))
    .limit(100);
  res.json(ListVerificationsResponse.parse(events.map(verificationResponse)));
});

export default router;