import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Router, type IRouter } from "express";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { db, computeProvidersTable, providerJobsTable } from "@isogate/db";
import {
  BindProviderWalletBody,
  BindProviderWalletParams,
  BindProviderWalletResponse,
  CreateProviderWalletChallengeBody,
  CreateProviderWalletChallengeParams,
  CreateProviderWalletChallengeResponse,
  GetProviderParams,
  GetProviderResponse,
  HeartbeatProviderParams,
  HeartbeatProviderResponse,
  ClaimProviderJobParams,
  ClaimProviderJobResponse,
  CompleteProviderJobBody,
  CompleteProviderJobParams,
  CompleteProviderJobResponse,
  GetProviderJobParams,
  GetProviderJobResponse,
  RegisterProviderBody,
  RegisterProviderResponse,
  RevokeProviderCredentialParams,
  RotateProviderCredentialParams,
  RotateProviderCredentialResponse,
  RunProviderJobBody,
  RunProviderJobParams,
  RunProviderJobResponse,
} from "@isogate/api-zod";
import { runCpuArt, runCpuReplay } from "../lib/cpu-replay";
import { getAddress, verifyMessage } from "viem";

const router: IRouter = Router();

function digestReport(report: Record<string, unknown>) {
  const { reportDigest: _ignored, ...payload } = report;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

const CREDENTIAL_HEADER = "x-isogate-provider-credential";
const CHAIN_ID = 4663;
const LEASE_DURATION_MS = 120_000;
const CHALLENGE_DURATION_MS = 5 * 60_000;

const limiterSalt = randomBytes(32).toString("hex");
const MAX_LIMITER_WINDOWS = 10_000;
const limiterWindows = new Map<string, { startedAt: number; count: number }>();
const limiterCleanup = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, window] of limiterWindows) {
    if (window.startedAt < cutoff) limiterWindows.delete(key);
  }
}, 60_000);
limiterCleanup.unref();

function requestIp(req: { ip?: string; socket: { remoteAddress?: string } }) {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function rateLimitKey(req: { ip?: string; socket: { remoteAddress?: string } }, bucket: string) {
  return `${bucket}:${createHash("sha256").update(`${limiterSalt}:${requestIp(req)}`, "utf8").digest("hex")}`;
}

function rateLimit(
  req: { ip?: string; socket: { remoteAddress?: string } },
  res: { set(name: string, value: string): unknown; status(code: number): { json(body: unknown): unknown } },
  bucket: string,
  limit: number,
) {
  const now = Date.now();
  const key = rateLimitKey(req, bucket);
  const current = limiterWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    if (limiterWindows.size >= MAX_LIMITER_WINDOWS) {
      const oldestKey = limiterWindows.keys().next().value;
      if (oldestKey) limiterWindows.delete(oldestKey);
    }
    limiterWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((current.startedAt + 60_000 - now) / 1000));
    res.set("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many requests." });
    return false;
  }
  current.count += 1;
  return true;
}

function hashCredential(credential: string) {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

function hasProviderCredential(
  req: { get(name: string): string | undefined },
  credentialHash: string | null,
) {
  const supplied = req.get(CREDENTIAL_HEADER) ?? "";
  const suppliedHash = hashCredential(supplied);
  // Compare fixed-size digests even for legacy rows without credentials.
  // Legacy providers must never regain privileged access implicitly.
  const expectedHash = credentialHash && /^[a-f0-9]{64}$/i.test(credentialHash)
    ? credentialHash
    : "0".repeat(64);
  return timingSafeEqual(
    Buffer.from(suppliedHash, "ascii"),
    Buffer.from(expectedHash, "ascii"),
  ) && Boolean(credentialHash);
}

function suppliedCredentialHash(req: { get(name: string): string | undefined }) {
  return hashCredential(req.get(CREDENTIAL_HEADER) ?? "");
}

function hashesMatch(suppliedHash: string, storedHash: string | null) {
  const expectedHash = storedHash && /^[a-f0-9]{64}$/i.test(storedHash)
    ? storedHash
    : "0".repeat(64);
  return timingSafeEqual(
    Buffer.from(suppliedHash, "ascii"),
    Buffer.from(expectedHash, "ascii"),
  ) && Boolean(storedHash);
}

function requireProviderCredential(
  req: { get(name: string): string | undefined },
  row: Pick<typeof computeProvidersTable.$inferSelect, "credentialHash">,
  res: { status(code: number): { json(body: unknown): unknown } },
) {
  if (hasProviderCredential(req, row.credentialHash)) return true;
  res.status(401).json({ error: "Provider authorization required." });
  return false;
}

function providerResponse(row: typeof computeProvidersTable.$inferSelect) {
  const online = row.status === "online" && Date.now() - row.lastSeenAt.getTime() < 90_000;
  return {
    id: row.id,
    status: online ? "online" as const : "offline" as const,
    reportDigest: row.reportDigest,
    cpuVendor: row.cpuVendor,
    cpuModel: row.cpuModel,
    architecture: row.architecture,
    logicalProcessors: row.logicalProcessors,
    walletAddress: row.walletAddress,
    walletBoundAt: row.walletBoundAt,
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function jobResponse(row: typeof providerJobsTable.$inferSelect) {
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

router.post("/providers", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "provider-registration", 5)) return;
  const parsed = RegisterProviderBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issueCount: parsed.error.issues.length }, "Provider report rejected");
    res.status(400).json({ error: "Provide a valid Isogate Native Node report." });
    return;
  }

  const report = parsed.data.report;
  if (digestReport(report as unknown as Record<string, unknown>) !== report.reportDigest) {
    req.log.warn("Provider report digest mismatch");
    res.status(400).json({ error: "Native report digest does not match its payload." });
    return;
  }

  const credential = randomBytes(32).toString("base64url");
  const [row] = await db.insert(computeProvidersTable).values({
    id: randomUUID(),
    credentialHash: hashCredential(credential),
    reportDigest: report.reportDigest,
    cpuVendor: report.cpu.vendor,
    cpuModel: report.cpu.model,
    architecture: report.runtime.architectureFamily,
    logicalProcessors: report.cpu.logicalProcessors,
    report,
  }).returning();

  req.log.info({ providerId: row.id, architecture: row.architecture }, "Compute provider registered");
  res.status(201).json(RegisterProviderResponse.parse({
    provider: providerResponse(row),
    credential,
  }));
});

router.post("/providers/:providerId/wallet/challenge", async (req, res): Promise<void> => {
  const params = CreateProviderWalletChallengeParams.safeParse(req.params);
  const body = CreateProviderWalletChallengeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid provider ID and wallet address." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `wallet-challenge:${provider.id}`, 10)) return;

  let walletAddress: string;
  try {
    walletAddress = getAddress(body.data.walletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid wallet address." });
    return;
  }
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_DURATION_MS);
  const nonce = randomBytes(32).toString("hex");
  const message = [
    "Isogate wallet ownership challenge",
    `Provider ID: ${provider.id}`,
    `Wallet: ${walletAddress}`,
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expires At: ${expiresAt.toISOString()}`,
    "Sign this message with your wallet using personal_sign.",
  ].join("\n");
  const [updated] = await db.update(computeProvidersTable).set({
    walletChallengeHash: hashCredential(message),
    walletChallengeExpiresAt: expiresAt,
  }).where(and(
    eq(computeProvidersTable.id, provider.id),
    eq(computeProvidersTable.credentialHash, suppliedCredentialHash(req)),
  )).returning();
  if (!updated) {
    res.status(409).json({ error: "Provider credentials changed; retry the request." });
    return;
  }
  res.json(CreateProviderWalletChallengeResponse.parse({
    message,
    expiresAt,
    chainId: CHAIN_ID,
  }));
});

router.post("/providers/:providerId/wallet/bind", async (req, res): Promise<void> => {
  const params = BindProviderWalletParams.safeParse(req.params);
  const body = BindProviderWalletBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid wallet address, challenge message, and signature." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `wallet-bind:${provider.id}`, 10)) return;

  let walletAddress: string;
  try {
    walletAddress = getAddress(body.data.walletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid wallet address." });
    return;
  }
  const now = new Date();
  const submittedMessageHash = hashCredential(body.data.message);
  const storedHash = provider.walletChallengeHash;
  const hashMatches = storedHash !== null
    && /^[a-f0-9]{64}$/i.test(storedHash)
    && timingSafeEqual(
      Buffer.from(submittedMessageHash, "ascii"),
      Buffer.from(storedHash, "ascii"),
    );
  const messageHasExpectedContext = body.data.message.includes(`Provider ID: ${provider.id}`)
    && body.data.message.includes(`Wallet: ${walletAddress}`)
    && body.data.message.includes(`Chain ID: ${CHAIN_ID}`);
  if (
    !hashMatches
    || !messageHasExpectedContext
    || !provider.walletChallengeExpiresAt
    || provider.walletChallengeExpiresAt <= now
  ) {
    res.status(400).json({ error: "Wallet challenge is invalid or expired." });
    return;
  }
  let signatureValid = false;
  try {
    signatureValid = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message: body.data.message,
      signature: body.data.signature as `0x${string}`,
    });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    res.status(400).json({ error: "Wallet signature is invalid." });
    return;
  }
  const [bound] = await db.update(computeProvidersTable).set({
    walletAddress,
    walletBoundAt: now,
    walletChallengeHash: null,
    walletChallengeExpiresAt: null,
  }).where(and(
    eq(computeProvidersTable.id, provider.id),
    eq(computeProvidersTable.credentialHash, suppliedCredentialHash(req)),
    eq(computeProvidersTable.walletChallengeHash, storedHash as string),
    gt(computeProvidersTable.walletChallengeExpiresAt, now),
  )).returning();
  if (!bound) {
    res.status(409).json({ error: "Wallet challenge is no longer available." });
    return;
  }
  res.json(BindProviderWalletResponse.parse(providerResponse(bound)));
});

router.post("/providers/:providerId/credential/rotate", async (req, res): Promise<void> => {
  const params = RotateProviderCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid provider ID." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `credential-rotate:${provider.id}`, 5)) return;
  const credential = randomBytes(32).toString("base64url");
  const [rotated] = await db.update(computeProvidersTable).set({
    credentialHash: hashCredential(credential),
    walletChallengeHash: null,
    walletChallengeExpiresAt: null,
  }).where(and(
    eq(computeProvidersTable.id, provider.id),
    eq(computeProvidersTable.credentialHash, suppliedCredentialHash(req)),
  )).returning();
  if (!rotated) {
    res.status(409).json({ error: "Provider credentials changed; retry the request." });
    return;
  }
  res.json(RotateProviderCredentialResponse.parse({ credential }));
});

router.post("/providers/:providerId/credential/revoke", async (req, res): Promise<void> => {
  const params = RevokeProviderCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid provider ID." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `credential-revoke:${provider.id}`, 5)) return;
  const [revoked] = await db.update(computeProvidersTable).set({
    credentialHash: null,
    walletChallengeHash: null,
    walletChallengeExpiresAt: null,
    status: "offline",
  }).where(and(
    eq(computeProvidersTable.id, provider.id),
    eq(computeProvidersTable.credentialHash, suppliedCredentialHash(req)),
  )).returning();
  if (!revoked) {
    res.status(409).json({ error: "Provider credentials changed; retry the request." });
    return;
  }
  res.sendStatus(204);
});

router.get("/providers/:providerId", async (req, res): Promise<void> => {
  const params = GetProviderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid provider ID." });
    return;
  }
  const [row] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  res.json(GetProviderResponse.parse(providerResponse(row)));
});

router.post("/providers/:providerId/heartbeat", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "provider-heartbeat-preauth", 120)) return;
  const params = HeartbeatProviderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid provider ID." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `provider-heartbeat:${provider.id}`, 60)) return;
  const [row] = await db.update(computeProvidersTable)
    .set({ lastSeenAt: new Date(), status: "online" })
    .where(eq(computeProvidersTable.id, params.data.providerId)).returning();
  if (!row) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  res.json(HeartbeatProviderResponse.parse(providerResponse(row)));
});

router.post("/providers/:providerId/jobs", async (req, res): Promise<void> => {
  const params = RunProviderJobParams.safeParse(req.params);
  const body = RunProviderJobBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid provider ID, eight bytes, and 1 to 32 cycles." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (body.data.workload === "cpu_art_rgb565") {
    const providerOnline = provider.status === "online"
      && Date.now() - provider.lastSeenAt.getTime() < 90_000;
    if (!providerOnline || !provider.walletAddress || !provider.walletBoundAt) {
      res.status(409).json({ error: "An online wallet-bound Native Node is required before queueing CPU art work." });
      return;
    }
    if (!body.data.creatorWalletAddress || !provider.walletAddress) {
      res.status(409).json({ error: "CPU art work must identify the creator wallet bound to the provider." });
      return;
    }
    try {
      if (getAddress(body.data.creatorWalletAddress) !== getAddress(provider.walletAddress)) {
        res.status(409).json({ error: "The Native Node wallet must match the creator wallet." });
        return;
      }
    } catch {
      res.status(400).json({ error: "Provide a valid creator wallet address." });
      return;
    }
  }
  if (!provider.walletAddress || !provider.walletBoundAt) {
    res.status(409).json({ error: "Bind a verified wallet before queueing provider work." });
    return;
  }

  const id = randomUUID();
  const [job] = await db.insert(providerJobsTable).values({
    id,
    providerId: provider.id,
    inputs: body.data.inputs,
    cycles: body.data.cycles ?? 32,
    workload: body.data.workload ?? "cpu_replay",
    creatorWalletAddress: body.data.creatorWalletAddress ?? null,
  }).returning();

  req.log.info(
    { providerId: provider.id, jobId: id, cycles: job.cycles },
    "Provider job queued",
  );
  res.status(201).json(RunProviderJobResponse.parse(jobResponse(job)));
});

router.get("/providers/:providerId/jobs/next", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "provider-claim-preauth", 120)) return;
  const params = ClaimProviderJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid provider ID." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `provider-claim:${provider.id}`, 60)) return;
  const now = new Date();
  // An expired identity workload is terminal: it must never become eligible
  // merely because a later Native Node claims the same request. Replay jobs
  // retain the existing retry behavior.
  await db.update(providerJobsTable).set({
    status: "rejected",
    verificationStatus: "expired",
    leaseExpiresAt: null,
    leaseTokenHash: null,
  }).where(and(
    eq(providerJobsTable.providerId, params.data.providerId),
    eq(providerJobsTable.status, "assigned"),
    eq(providerJobsTable.workload, "cpu_art_rgb565"),
    lte(providerJobsTable.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
  ));
  await db.update(providerJobsTable).set({
    status: "queued",
    assignedAt: null,
    leaseExpiresAt: null,
    leaseTokenHash: null,
  }).where(and(
    eq(providerJobsTable.providerId, params.data.providerId),
    eq(providerJobsTable.status, "assigned"),
    lte(providerJobsTable.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
    eq(providerJobsTable.workload, "cpu_replay"),
  ));
  const [queued] = await db.select().from(providerJobsTable)
    .where(and(
      eq(providerJobsTable.providerId, params.data.providerId),
      eq(providerJobsTable.status, "queued"),
    ))
    .orderBy(asc(providerJobsTable.createdAt))
    .limit(1);
  if (!queued) {
    res.json(null);
    return;
  }
  const assignedAt = now;
  const leaseExpiresAt = new Date(assignedAt.getTime() + LEASE_DURATION_MS);
  const leaseToken = randomBytes(32).toString("base64url");
  const [assigned] = await db.update(providerJobsTable)
    .set({
      status: "assigned",
      assignedAt,
      leaseExpiresAt,
      leaseTokenHash: hashCredential(leaseToken),
      attemptCount: sql`${providerJobsTable.attemptCount} + 1`,
    })
    .where(and(eq(providerJobsTable.id, queued.id), eq(providerJobsTable.status, "queued")))
    .returning();
  if (!assigned) {
    res.json(null);
    return;
  }
  await db.update(computeProvidersTable)
    .set({ lastSeenAt: assignedAt, status: "online" })
    .where(eq(computeProvidersTable.id, params.data.providerId));
  req.log.info({ providerId: params.data.providerId, jobId: assigned.id }, "Provider job assigned");
  const claimedResponse = ClaimProviderJobResponse.parse({ ...jobResponse(assigned), leaseToken });
  res.json(claimedResponse ? { ...claimedResponse, leaseToken } : claimedResponse);
});

router.get("/providers/:providerId/jobs/:jobId", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "provider-get-job-preauth", 120)) return;
  const params = GetProviderJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid provider or job ID." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `provider-get-job:${provider.id}`, 120)) return;
  const [job] = await db.select().from(providerJobsTable).where(and(
    eq(providerJobsTable.id, params.data.jobId),
    eq(providerJobsTable.providerId, params.data.providerId),
  )).limit(1);
  if (!job) {
    res.status(404).json({ error: "Provider job not found." });
    return;
  }
  res.json(GetProviderJobResponse.parse(jobResponse(job)));
});

router.post("/providers/:providerId/jobs/:jobId/complete", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "provider-complete-preauth", 120)) return;
  const params = CompleteProviderJobParams.safeParse(req.params);
  const body = CompleteProviderJobBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid lease token and provider result." });
    return;
  }
  const leaseToken = typeof req.body?.leaseToken === "string"
    ? req.body.leaseToken
    : (body.data as unknown as { leaseToken?: unknown }).leaseToken;
  if (!leaseToken || leaseToken.length < 32 || leaseToken.length > 128) {
    res.status(400).json({ error: "Provide a valid lease token and provider result." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, params.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (!requireProviderCredential(req, provider, res)) return;
  if (!rateLimit(req, res, `provider-complete:${provider.id}`, 60)) return;
  const [job] = await db.select().from(providerJobsTable).where(and(
    eq(providerJobsTable.id, params.data.jobId),
    eq(providerJobsTable.providerId, params.data.providerId),
  )).limit(1);
  if (!job) {
    res.status(404).json({ error: "Provider job not found." });
    return;
  }
  if (job.status !== "assigned") {
    res.status(409).json({ error: "Provider job is not awaiting a result." });
    return;
  }
  const leaseTokenHash = hashCredential(leaseToken);
  if (!hashesMatch(leaseTokenHash, job.leaseTokenHash)) {
    res.status(409).json({ error: "Provider job lease is stale or invalid." });
    return;
  }
  const expected = job.workload === "cpu_art_rgb565"
    ? runCpuArt({ seed: job.inputs as number[] })
    : runCpuReplay({ inputs: job.inputs as number[], cycles: job.cycles });
  // Compare validated values semantically: object property insertion order is
  // irrelevant, while every field, scalar, and array element remains exact.
  const exactMatch = isDeepStrictEqual(body.data.result, expected);
  if (!exactMatch) {
    const [rejected] = await db.update(providerJobsTable).set({
      status: "rejected",
      verificationStatus: "mismatch",
      leaseExpiresAt: null,
      leaseTokenHash: null,
    })
      .where(and(
        eq(providerJobsTable.id, job.id),
        eq(providerJobsTable.providerId, params.data.providerId),
        eq(providerJobsTable.status, "assigned"),
        eq(providerJobsTable.leaseTokenHash, leaseTokenHash),
        gt(providerJobsTable.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
      )).returning();
    if (!rejected) {
      const [requeued] = await db.update(providerJobsTable).set({
        status: "queued",
        assignedAt: null,
        leaseExpiresAt: null,
        leaseTokenHash: null,
        completedAt: null,
      }).where(and(
        eq(providerJobsTable.id, job.id),
        eq(providerJobsTable.providerId, params.data.providerId),
        eq(providerJobsTable.status, "assigned"),
        eq(providerJobsTable.leaseTokenHash, leaseTokenHash),
        lte(providerJobsTable.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
      )).returning();
      if (requeued) {
        req.log.warn({ providerId: job.providerId, jobId: job.id }, "Expired provider job lease requeued");
      }
      res.status(409).json({ error: "Provider job is no longer awaiting a result." });
      return;
    }
    req.log.warn({ providerId: job.providerId, jobId: job.id }, "Native provider result rejected");
    res.status(400).json({ error: "Native result does not match the assigned deterministic workload." });
    return;
  }
  const completedAt = new Date();
  const expectedDigest = "digest" in expected ? expected.digest : expected.imageDigest;
  const [completed] = await db.update(providerJobsTable).set({
    status: "completed",
    verificationStatus: "verified",
    result: expected,
    digest: expectedDigest,
    completedAt,
    leaseExpiresAt: null,
    leaseTokenHash: null,
  }).where(and(
    eq(providerJobsTable.id, job.id),
    eq(providerJobsTable.providerId, params.data.providerId),
    eq(providerJobsTable.status, "assigned"),
    eq(providerJobsTable.leaseTokenHash, leaseTokenHash),
    gt(providerJobsTable.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
  )).returning();
  if (!completed) {
    const [requeued] = await db.update(providerJobsTable).set({
      status: "queued",
      assignedAt: null,
      leaseExpiresAt: null,
      leaseTokenHash: null,
      completedAt: null,
    }).where(and(
      eq(providerJobsTable.id, job.id),
      eq(providerJobsTable.providerId, params.data.providerId),
      eq(providerJobsTable.status, "assigned"),
      eq(providerJobsTable.leaseTokenHash, leaseTokenHash),
      lte(providerJobsTable.leaseExpiresAt, sql`CURRENT_TIMESTAMP`),
    )).returning();
    if (requeued) {
      req.log.warn({ providerId: job.providerId, jobId: job.id }, "Expired provider job lease requeued");
    }
    res.status(409).json({ error: "Provider job is no longer awaiting a result." });
    return;
  }
  await db.update(computeProvidersTable)
    .set({ lastSeenAt: completedAt, status: "online" })
    .where(eq(computeProvidersTable.id, job.providerId));
  req.log.info({
    providerId: job.providerId,
    jobId: job.id,
    digestPrefix: expectedDigest.slice(0, 12),
  }, "Native provider job verified");
  res.json(CompleteProviderJobResponse.parse(jobResponse(completed)));
});

export default router;