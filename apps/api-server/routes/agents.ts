import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getAddress, verifyMessage } from "viem";
import {
  agentEventsTable,
  agentsTable,
  computeProvidersTable,
  db,
  providerJobsTable,
} from "@isogate/db";
import {
  BindAgentWalletBody,
  BindAgentWalletParams,
  BindAgentWalletResponse,
  CreateAgentWalletChallengeBody,
  CreateAgentWalletChallengeParams,
  CreateAgentWalletChallengeResponse,
  GetAgentParams,
  GetAgentResponse,
  ListAgentEventsParams,
  ListAgentEventsResponse,
  RegisterAgentBody,
  RegisterAgentResponse,
  RevokeAgentCredentialParams,
  RotateAgentCredentialParams,
  RotateAgentCredentialResponse,
  SubmitAgentJobBody,
  SubmitAgentJobParams,
  SubmitAgentJobResponse,
  UpdateAgentPolicyBody,
  UpdateAgentPolicyParams,
  UpdateAgentPolicyResponse,
} from "@isogate/api-zod";

const router: IRouter = Router();
const CREDENTIAL_HEADER = "x-isogate-agent-credential";
const CHAIN_ID = 4663;
const CHALLENGE_DURATION_MS = 5 * 60_000;
const limiterSalt = randomBytes(32).toString("hex");
const limiterWindows = new Map<string, { startedAt: number; count: number }>();
const MAX_LIMITER_WINDOWS = 10_000;
const limiterCleanup = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, window] of limiterWindows) {
    if (window.startedAt < cutoff) limiterWindows.delete(key);
  }
}, 60_000);
limiterCleanup.unref();

type AgentRow = typeof agentsTable.$inferSelect;

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHash(supplied: string, stored: string | null) {
  const expected = stored && /^[a-f0-9]{64}$/i.test(stored) ? stored : "0".repeat(64);
  return timingSafeEqual(Buffer.from(hash(supplied), "ascii"), Buffer.from(expected, "ascii"))
    && Boolean(stored);
}

function requestIp(req: { ip?: string; socket: { remoteAddress?: string } }) {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function rateLimit(
  req: { ip?: string; socket: { remoteAddress?: string } },
  res: { set(name: string, value: string): unknown; status(code: number): { json(body: unknown): unknown } },
  bucket: string,
  limit: number,
) {
  const now = Date.now();
  const key = `${bucket}:${hash(`${limiterSalt}:${requestIp(req)}`)}`;
  const current = limiterWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    if (limiterWindows.size >= MAX_LIMITER_WINDOWS) {
      const oldest = limiterWindows.keys().next().value;
      if (oldest) limiterWindows.delete(oldest);
    }
    limiterWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((current.startedAt + 60_000 - now) / 1000))));
    res.status(429).json({ error: "Too many requests." });
    return false;
  }
  current.count += 1;
  return true;
}

function agentResponse(row: AgentRow) {
  const policy = row.policy as {
    enabled: boolean;
    operation: "cpu_replay";
    maxCycles: number;
    maxInputs: number;
    expiresAt: string | null;
  };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as "active" | "offline" | "revoked",
    ownerWalletAddress: row.ownerWalletAddress,
    ownerWalletBoundAt: row.ownerWalletBoundAt?.toISOString() ?? null,
    policy: {
      ...policy,
      expiresAt: policy.expiresAt ? new Date(policy.expiresAt) : null,
    },
    policyVersion: row.policyVersion,
    policyHash: row.policyHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
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
    createdAt: row.createdAt,
    assignedAt: row.assignedAt,
    leaseExpiresAt: row.leaseExpiresAt,
    attemptCount: row.attemptCount,
    completedAt: row.completedAt,
    result: row.result ?? null,
  };
}

async function addEvent(
  agentId: string,
  type: string,
  metadata: Record<string, unknown>,
  providerJobId?: string,
) {
  await db.insert(agentEventsTable).values({
    id: randomUUID(),
    agentId,
    type,
    providerJobId: providerJobId ?? null,
    metadata,
  });
}

async function findAuthenticatedAgent(req: { get(name: string): string | undefined }, agentId: string) {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1);
  if (!agent || !agent.credentialHash || agent.status === "revoked") return null;
  const credential = req.get(CREDENTIAL_HEADER) ?? "";
  return sameHash(credential, agent.credentialHash) ? { agent, credentialHash: hash(credential) } : null;
}

function requireAgent(
  authenticated: Awaited<ReturnType<typeof findAuthenticatedAgent>>,
  res: { status(code: number): { json(body: unknown): unknown } },
) {
  if (authenticated) return true;
  res.status(401).json({ error: "Agent authorization required." });
  return false;
}

function canonicalPolicy(policy: {
  enabled: boolean;
  operation: "cpu_replay";
  maxCycles: number;
  maxInputs: number;
  expiresAt: Date | null;
}) {
  return {
    enabled: policy.enabled,
    operation: policy.operation,
    maxCycles: policy.maxCycles,
    maxInputs: policy.maxInputs,
    expiresAt: policy.expiresAt?.toISOString() ?? null,
  };
}

router.post("/agents", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-registration", 5)) return;
  const body = RegisterAgentBody.safeParse(req.body);
  if (!body.success) {
    req.log.warn({ issueCount: body.error.issues.length }, "Agent registration rejected");
    res.status(400).json({ error: "Provide a valid agent name and description." });
    return;
  }
  const now = new Date();
  const policy = canonicalPolicy({
    enabled: true,
    operation: "cpu_replay",
    maxCycles: 32,
    maxInputs: 8,
    expiresAt: null,
  });
  const credential = randomBytes(32).toString("base64url");
  const [agent] = await db.insert(agentsTable).values({
    id: randomUUID(),
    name: body.data.name,
    description: body.data.description ?? null,
    credentialHash: hash(credential),
    policy,
    policyVersion: 1,
    policyHash: hash(JSON.stringify(policy)),
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  }).returning();
  await addEvent(agent.id, "registered", {});
  req.log.info({ agentId: agent.id, eventType: "registered" }, "Agent registered");
  res.status(201).json(RegisterAgentResponse.parse({ agent: agentResponse(agent), credential }));
});

router.get("/agents/:agentId", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-preauth", 120)) return;
  const params = GetAgentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid agent ID." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent:${params.data.agentId}`, 120)) return;
  res.json(GetAgentResponse.parse(agentResponse(authenticated!.agent)));
});

router.post("/agents/:agentId/wallet/challenge", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-wallet-challenge-preauth", 120)) return;
  const params = CreateAgentWalletChallengeParams.safeParse(req.params);
  const body = CreateAgentWalletChallengeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid agent ID and wallet address." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent-wallet-challenge:${params.data.agentId}`, 10)) return;
  let address: string;
  try {
    address = getAddress(body.data.walletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid wallet address." });
    return;
  }
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_DURATION_MS);
  const message = [
    "Isogate agent wallet ownership challenge",
    `Agent ID: ${authenticated!.agent.id}`,
    `Wallet: ${address}`,
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${randomBytes(32).toString("hex")}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expires At: ${expiresAt.toISOString()}`,
    "Sign this message with your wallet using personal_sign.",
  ].join("\n");
  const [updated] = await db.update(agentsTable).set({
    walletChallengeHash: hash(message),
    walletChallengeExpiresAt: expiresAt,
  }).where(and(
    eq(agentsTable.id, authenticated!.agent.id),
    eq(agentsTable.credentialHash, authenticated!.credentialHash),
  )).returning();
  if (!updated) {
    res.status(409).json({ error: "Agent credentials changed; retry the request." });
    return;
  }
  res.json(CreateAgentWalletChallengeResponse.parse({
    message,
    address,
    chainId: CHAIN_ID,
    expiresAt,
  }));
});

router.post("/agents/:agentId/wallet/bind", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-wallet-bind-preauth", 120)) return;
  const params = BindAgentWalletParams.safeParse(req.params);
  const body = BindAgentWalletBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid wallet address, challenge message, and signature." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent-wallet-bind:${params.data.agentId}`, 10)) return;
  let address: string;
  try {
    address = getAddress(body.data.walletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid wallet address." });
    return;
  }
  const now = new Date();
  const challengeHash = hash(body.data.message);
  const storedHash = authenticated!.agent.walletChallengeHash;
  const challengeMatches = storedHash && /^[a-f0-9]{64}$/i.test(storedHash)
    ? timingSafeEqual(Buffer.from(challengeHash, "ascii"), Buffer.from(storedHash, "ascii"))
    : false;
  const expectedContext = body.data.message.includes(`Agent ID: ${authenticated!.agent.id}`)
    && body.data.message.includes(`Wallet: ${address}`)
    && body.data.message.includes(`Chain ID: ${CHAIN_ID}`);
  if (!challengeMatches || !expectedContext || !authenticated!.agent.walletChallengeExpiresAt
      || authenticated!.agent.walletChallengeExpiresAt <= now) {
    res.status(400).json({ error: "Wallet challenge is invalid or expired." });
    return;
  }
  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: body.data.message,
      signature: body.data.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    res.status(400).json({ error: "Wallet signature is invalid." });
    return;
  }
  const [bound] = await db.update(agentsTable).set({
    ownerWalletAddress: address,
    ownerWalletBoundAt: now,
    walletChallengeHash: null,
    walletChallengeExpiresAt: null,
    updatedAt: now,
    lastSeenAt: now,
  }).where(and(
    eq(agentsTable.id, authenticated!.agent.id),
    eq(agentsTable.credentialHash, authenticated!.credentialHash),
    eq(agentsTable.walletChallengeHash, storedHash as string),
    gt(agentsTable.walletChallengeExpiresAt, now),
  )).returning();
  if (!bound) {
    res.status(409).json({ error: "Wallet challenge is no longer available." });
    return;
  }
  await addEvent(bound.id, "wallet_bound", {});
  res.json(BindAgentWalletResponse.parse(agentResponse(bound)));
});

router.patch("/agents/:agentId/policy", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-policy-preauth", 120)) return;
  const params = UpdateAgentPolicyParams.safeParse(req.params);
  const body = UpdateAgentPolicyBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid agent policy." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent-policy:${params.data.agentId}`, 30)) return;
  const expiresAt = body.data.expiresAt;
  if (expiresAt && expiresAt <= new Date()) {
    res.status(400).json({ error: "Policy expiration must be in the future." });
    return;
  }
  const policy = canonicalPolicy({ ...body.data, expiresAt });
  const [updated] = await db.update(agentsTable).set({
    policy,
    policyVersion: authenticated!.agent.policyVersion + 1,
    policyHash: hash(JSON.stringify(policy)),
    updatedAt: new Date(),
  }).where(and(
    eq(agentsTable.id, authenticated!.agent.id),
    eq(agentsTable.credentialHash, authenticated!.credentialHash),
    eq(agentsTable.status, "active"),
    eq(agentsTable.policyVersion, authenticated!.agent.policyVersion),
  )).returning();
  if (!updated) {
    res.status(409).json({ error: "Agent credentials changed; retry the request." });
    return;
  }
  await addEvent(updated.id, "policy_updated", { policyVersion: updated.policyVersion });
  res.json(UpdateAgentPolicyResponse.parse(agentResponse(updated)));
});

router.post("/agents/:agentId/jobs", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-jobs-preauth", 120)) return;
  const params = SubmitAgentJobParams.safeParse(req.params);
  const body = SubmitAgentJobBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid provider, inputs, and cycles." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent-jobs:${params.data.agentId}`, 60)) return;
  const agent = authenticated!.agent;
  const policy = agent.policy as {
    enabled: boolean; operation: string; maxCycles: number; maxInputs: number; expiresAt: string | null;
  };
  if (agent.status !== "active") {
    res.status(409).json({ error: "Agent is not active." });
    return;
  }
  if (!agent.ownerWalletAddress || !agent.ownerWalletBoundAt) {
    res.status(409).json({ error: "Bind a verified wallet before queueing agent work." });
    return;
  }
  if (!policy.enabled || policy.operation !== "cpu_replay"
      || (policy.expiresAt !== null && new Date(policy.expiresAt) <= new Date())) {
    res.status(409).json({ error: "Agent policy is not active." });
    return;
  }
  if (body.data.cycles > policy.maxCycles || body.data.inputs.length > policy.maxInputs) {
    res.status(400).json({ error: "Job exceeds the active agent policy." });
    return;
  }
  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, body.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  if (provider.status !== "online" || !provider.credentialHash
      || !provider.walletAddress || !provider.walletBoundAt) {
    res.status(409).json({ error: "Provider is not eligible for agent work." });
    return;
  }
  const job = await db.transaction(async (tx) => {
    const acceptedAt = new Date();
    const [acceptedAgent] = await tx.update(agentsTable).set({
      lastSeenAt: acceptedAt,
    }).where(and(
      eq(agentsTable.id, agent.id),
      eq(agentsTable.credentialHash, authenticated!.credentialHash),
      eq(agentsTable.status, "active"),
      eq(agentsTable.policyVersion, agent.policyVersion),
      eq(agentsTable.policyHash, agent.policyHash),
      eq(agentsTable.ownerWalletAddress, agent.ownerWalletAddress!),
    )).returning();
    if (!acceptedAgent) throw new Error("AGENT_STATE_CHANGED");
    const currentPolicy = acceptedAgent.policy as typeof policy;
    if (!currentPolicy.enabled || currentPolicy.operation !== "cpu_replay"
        || (currentPolicy.expiresAt !== null && new Date(currentPolicy.expiresAt) <= acceptedAt)
        || body.data.cycles > currentPolicy.maxCycles
        || body.data.inputs.length > currentPolicy.maxInputs) {
      throw new Error("AGENT_STATE_CHANGED");
    }
    const [acceptedProvider] = await tx.update(computeProvidersTable).set({
      lastSeenAt: sql`${computeProvidersTable.lastSeenAt}`,
    }).where(and(
      eq(computeProvidersTable.id, provider.id),
      sql`${computeProvidersTable.credentialHash} IS NOT NULL`,
      sql`${computeProvidersTable.status} <> 'revoked'`,
      sql`${computeProvidersTable.walletAddress} IS NOT NULL`,
      sql`${computeProvidersTable.walletBoundAt} IS NOT NULL`,
    )).returning();
    if (!acceptedProvider) throw new Error("AGENT_STATE_CHANGED");
    const [acceptedJob] = await tx.insert(providerJobsTable).values({
      id: randomUUID(),
      providerId: acceptedProvider.id,
      agentId: acceptedAgent.id,
      agentPolicyHash: acceptedAgent.policyHash,
      agentPolicyVersion: acceptedAgent.policyVersion,
      agentOwnerWalletAddress: acceptedAgent.ownerWalletAddress,
      inputs: body.data.inputs,
      cycles: body.data.cycles,
    }).returning();
    return acceptedJob;
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "AGENT_STATE_CHANGED") return null;
    throw error;
  });
  if (!job) {
    res.status(409).json({ error: "Agent or provider state changed; retry the request." });
    return;
  }
  await addEvent(agent.id, "job_submitted", { cycles: job.cycles, inputCount: body.data.inputs.length }, job.id);
  req.log.info({ agentId: agent.id, providerId: provider.id, jobId: job.id, eventType: "job_submitted" }, "Agent job queued");
  res.status(201).json(SubmitAgentJobResponse.parse(jobResponse(job)));
});

router.get("/agents/:agentId/events", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-events-preauth", 120)) return;
  const params = ListAgentEventsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid agent ID." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent-events:${params.data.agentId}`, 60)) return;
  const events = await db.select().from(agentEventsTable)
    .where(eq(agentEventsTable.agentId, params.data.agentId))
    .orderBy(desc(agentEventsTable.createdAt))
    .limit(100);
  res.json(ListAgentEventsResponse.parse(events.map((event) => ({
    id: event.id,
    type: event.type,
    providerJobId: event.providerJobId,
    metadata: event.metadata,
    createdAt: event.createdAt,
  }))));
});

router.post("/agents/:agentId/credential/rotate", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-credential-rotate-preauth", 120)) return;
  const params = RotateAgentCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid agent ID." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent-credential-rotate:${params.data.agentId}`, 5)) return;
  const credential = randomBytes(32).toString("base64url");
  const [rotated] = await db.update(agentsTable).set({
    credentialHash: hash(credential),
    walletChallengeHash: null,
    walletChallengeExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(agentsTable.id, authenticated!.agent.id),
    eq(agentsTable.credentialHash, authenticated!.credentialHash),
    eq(agentsTable.status, "active"),
  )).returning();
  if (!rotated) {
    res.status(409).json({ error: "Agent credentials changed; retry the request." });
    return;
  }
  await addEvent(rotated.id, "credential_rotated", {});
  res.json(RotateAgentCredentialResponse.parse({ credential }));
});

router.post("/agents/:agentId/credential/revoke", async (req, res): Promise<void> => {
  if (!rateLimit(req, res, "agent-credential-revoke-preauth", 120)) return;
  const params = RevokeAgentCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid agent ID." });
    return;
  }
  const authenticated = await findAuthenticatedAgent(req, params.data.agentId);
  if (!requireAgent(authenticated, res)) return;
  if (!rateLimit(req, res, `agent-credential-revoke:${params.data.agentId}`, 5)) return;
  const [revoked] = await db.update(agentsTable).set({
    credentialHash: null,
    walletChallengeHash: null,
    walletChallengeExpiresAt: null,
    status: "revoked",
    revokedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(agentsTable.id, authenticated!.agent.id),
    eq(agentsTable.credentialHash, authenticated!.credentialHash),
    eq(agentsTable.status, "active"),
  )).returning();
  if (!revoked) {
    res.status(409).json({ error: "Agent credentials changed; retry the request." });
    return;
  }
  await addEvent(revoked.id, "credential_revoked", {});
  res.sendStatus(204);
});

export default router;