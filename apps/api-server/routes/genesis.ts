import { Router, type IRouter } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { getAddress, verifyMessage } from "viem";
import {
  db,
  approvedGenesisRecipesTable,
  computeProvidersTable,
  genesisApprovalChallengesTable,
  providerJobsTable,
} from "@isogate/db";
import {
  CreateGenesisApprovalChallengeBody,
  CreateGenesisApprovalChallengeParams,
  CreateGenesisApprovalChallengeResponse,
  DownloadGenesisPngParams,
  GenerateGenesisArtBody,
  GenerateGenesisArtResponse,
  ApproveGenesisArtBody,
  ApproveGenesisArtParams,
  GetApprovedGenesisRecipeParams,
  GetApprovedGenesisRecipeResponse,
  GetGenesisArtParams,
} from "@isogate/api-zod";
import {
  approvalNonceHash,
  approvalMessageDigest,
  buildGenesisApprovalMessage,
  recomputeVerifiedGenesisJob,
} from "../lib/genesis-identity";
import { encodeGenesisPngWithDigest } from "../lib/genesis-png";
import {
  applyWriteOncePinataResult,
  canClaimGenesisUpload,
  GENESIS_UPLOAD_LEASE_MS,
  uploadGenesisSnapshot,
} from "../lib/genesis-upload";
import {
  issueGenesisDeploymentProof,
  verifyGenesisDeploymentConfig,
} from "../lib/genesis-deployment-proof";
import { assertGenesisV2RuntimeAssetsAvailable } from "../lib/genesis-launch-reconciliation";

const router: IRouter = Router();
const CHAIN_ID = 4663;
const APPROVAL_CHALLENGE_DURATION_MS = 10 * 60_000;

function response(
  row: typeof providerJobsTable.$inferSelect,
  artifact?: typeof approvedGenesisRecipesTable.$inferSelect | null,
) {
  const result = row.workload === "cpu_art_rgb565" ? row.result ?? null : null;
  return {
    jobId: row.id,
    providerId: row.providerId,
    workload: row.workload as "cpu_art_rgb565",
    creatorWalletAddress: row.creatorWalletAddress!,
    status: row.status as "queued" | "assigned" | "completed" | "rejected",
    verificationStatus: row.verificationStatus as "queued" | "verified" | "mismatch" | "failed" | "expired",
    seed: row.inputs as number[],
    result,
    eligibleForApproval: row.status === "completed" && row.verificationStatus === "verified",
    creatorApprovedAt: row.creatorApprovedAt?.toISOString() ?? null,
    approved: row.creatorApprovedAt !== null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    ipfsCid: artifact?.ipfsCid ?? null,
    pngDigest: artifact?.pngDigest ?? null,
    uploadStatus: artifact?.uploadStatus ?? null,
    uploadStartedAt: artifact?.uploadStartedAt?.toISOString() ?? null,
    uploadedAt: artifact?.uploadedAt?.toISOString() ?? null,
    logoUri: artifact?.logoUri ?? null,
  };
}

function approvedRecipeResponse(row: typeof approvedGenesisRecipesTable.$inferSelect) {
  const storedProof = row.deploymentProofJson as Record<string, unknown> | null;
  return {
    id: row.id,
    providerJobId: row.providerJobId,
    providerId: row.providerId,
    walletAddress: row.walletAddress,
    tokenName: row.tokenName,
    symbol: row.symbol,
    description: row.description,
    seed: row.seed,
    pixels: row.pixels,
    engineVersion: row.engineVersion,
    cycles: 32 as const,
    cpuDigest: row.cpuDigest,
    imageDigest: row.imageDigest,
    logoUri: row.logoUri,
    deploymentProof: storedProof ? deploymentProofResponse(storedProof, row) : null,
    ipfsCid: row.ipfsCid,
    pngDigest: row.pngDigest,
    uploadStatus: row.uploadStatus,
    uploadStartedAt: row.uploadStartedAt?.toISOString() ?? null,
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt.toISOString(),
  };
}

function deploymentProofResponse(
  stored: Record<string, unknown>,
  row: typeof approvedGenesisRecipesTable.$inferSelect,
) {
  const proof = (stored.proof ?? stored) as Record<string, unknown>;
  const deploymentConfig = row.deploymentConfigJson as Record<string, unknown> | null;
  const expiry = String(proof.expiry);
  const currentStatus = row.deploymentStatus === "issued"
    && Number(expiry) * 1000 <= Date.now()
    ? "expired"
    : stored.status ?? row.deploymentStatus;
  return {
    version: typeof deploymentConfig?.version === "string" ? deploymentConfig.version : "v1",
    providerJobRef: proof.providerJobRef,
    providerRef: proof.providerRef,
    creator: proof.creator,
    factory: proof.factory,
    protocol: proof.protocol,
    tokenName: proof.name ?? proof.tokenName,
    symbol: proof.symbol,
    descriptionHash: proof.descriptionHash,
    engineHash: proof.engineHash,
    seedHash: proof.seedHash,
    cpuDigest: proof.cpuDigest,
    imageDigest: proof.imageDigest,
    logoUri: proof.logoUri,
    expiry,
    nonce: String(proof.nonce),
    signature: stored.signature,
    digest: stored.digest,
    verifier: stored.verifier,
    issuedAt: stored.issuedAt ?? row.deploymentIssuedAt?.toISOString(),
    status: currentStatus,
  };
}

router.post("/genesis/art", async (req, res): Promise<void> => {
  const parsed = GenerateGenesisArtBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ issueCount: parsed.error.issues.length }, "Genesis Native Node workload rejected");
    res.status(400).json({ error: "Provide a seed, creator wallet, and online provider ID." });
    return;
  }

  let creatorWalletAddress: string;
  try {
    creatorWalletAddress = getAddress(parsed.data.creatorWalletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid creator wallet address." });
    return;
  }

  const [provider] = await db.select().from(computeProvidersTable)
    .where(eq(computeProvidersTable.id, parsed.data.providerId)).limit(1);
  if (!provider) {
    res.status(404).json({ error: "Provider not found." });
    return;
  }
  const online = provider.status === "online"
    && Date.now() - provider.lastSeenAt.getTime() < 90_000;
  if (!online || !provider.walletAddress || !provider.walletBoundAt) {
    res.status(409).json({ error: "An online wallet-bound Native Node is required." });
    return;
  }
  if (getAddress(provider.walletAddress) !== creatorWalletAddress) {
    res.status(409).json({ error: "The Native Node wallet must match the creator wallet." });
    return;
  }

  const [job] = await db.insert(providerJobsTable).values({
    id: randomUUID(),
    providerId: provider.id,
    workload: "cpu_art_rgb565",
    creatorWalletAddress,
    inputs: parsed.data.seed,
    cycles: 32,
  }).returning();

  req.log.info({ jobId: job.id, providerId: provider.id }, "Genesis Native Node workload queued");
  res.status(201).json(GenerateGenesisArtResponse.parse(response(job)));
});

router.get("/genesis/art/:jobId", async (req, res): Promise<void> => {
  const parsed = GetGenesisArtParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid genesis workload ID." });
    return;
  }
  const [job] = await db.select().from(providerJobsTable)
    .where(eq(providerJobsTable.id, parsed.data.jobId)).limit(1);
  if (!job || job.workload !== "cpu_art_rgb565") {
    res.status(404).json({ error: "Genesis workload not found." });
    return;
  }
  const [artifact] = await db.select().from(approvedGenesisRecipesTable)
    .where(eq(approvedGenesisRecipesTable.providerJobId, job.id)).limit(1);
  res.json(GenerateGenesisArtResponse.parse(response(job, artifact)));
});

router.post("/genesis/art/:jobId/challenge", async (req, res): Promise<void> => {
  const params = CreateGenesisApprovalChallengeParams.safeParse(req.params);
  const body = CreateGenesisApprovalChallengeBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid workload ID and creator wallet." });
    return;
  }
  let wallet: string;
  try {
    wallet = getAddress(body.data.creatorWalletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid creator wallet address." });
    return;
  }
  const [job] = await db.select().from(providerJobsTable)
    .where(eq(providerJobsTable.id, params.data.jobId)).limit(1);
  if (!job || job.workload !== "cpu_art_rgb565") {
    res.status(404).json({ error: "Genesis workload not found." });
    return;
  }
  if (job.creatorWalletAddress !== wallet) {
    res.status(403).json({ error: "Only the creator wallet may approve this identity." });
    return;
  }
  if (
    job.status !== "completed"
    || job.verificationStatus !== "verified"
    || !job.result
    || job.creatorApprovedAt
  ) {
    res.status(409).json({ error: "Only an exactly verified Native Node result can be approved." });
    return;
  }

  let snapshot: ReturnType<typeof recomputeVerifiedGenesisJob>;
  try {
    snapshot = recomputeVerifiedGenesisJob(job, wallet);
  } catch {
    res.status(409).json({ error: "Only an exact verified Native Node result can be approved." });
    return;
  }
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + APPROVAL_CHALLENGE_DURATION_MS);
  const expiresAtText = expiresAt.toISOString();
  const message = buildGenesisApprovalMessage({
    jobId: job.id,
    providerId: job.providerId,
    creatorWalletAddress: wallet,
    chainId: CHAIN_ID,
    expiresAt: expiresAtText,
    nonce,
    snapshot,
  });
  const [challenge] = await db.insert(genesisApprovalChallengesTable).values({
    id: randomUUID(),
    providerJobId: job.id,
    creatorWalletAddress: wallet,
    nonceHash: approvalNonceHash(nonce),
    messageDigest: approvalMessageDigest(message),
    expiresAt,
  }).returning();
  if (!challenge) {
    res.status(409).json({ error: "Verified genesis job changed; retry the challenge." });
    return;
  }
  res.json(CreateGenesisApprovalChallengeResponse.parse({
    jobId: job.id,
    providerId: job.providerId,
    creatorWalletAddress: wallet,
    chainId: CHAIN_ID,
    protocolVersion: "isogate-genesis-approval-v2",
    pngDigest: snapshot.pngDigest,
    tokenNameHash: snapshot.metadata.tokenNameHash,
    symbolHash: snapshot.metadata.symbolHash,
    descriptionHash: snapshot.metadata.descriptionHash,
    seedHash: snapshot.metadata.seedHash,
    cpuDigest: snapshot.metadata.cpuDigest,
    imageDigest: snapshot.metadata.imageDigest,
    nonce,
    message,
    expiresAt: expiresAt.toISOString(),
  }));
});

router.post("/genesis/art/:jobId/approve", async (req, res): Promise<void> => {
  const params = ApproveGenesisArtParams.safeParse(req.params);
  const body = ApproveGenesisArtBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Provide a valid workload ID and creator wallet." });
    return;
  }
  let wallet: string;
  try {
    wallet = getAddress(body.data.creatorWalletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid creator wallet address." });
    return;
  }
  const [job] = await db.select().from(providerJobsTable)
    .where(eq(providerJobsTable.id, params.data.jobId)).limit(1);
  if (!job || job.workload !== "cpu_art_rgb565") {
    res.status(404).json({ error: "Genesis workload not found." });
    return;
  }
  if (job.creatorWalletAddress !== wallet) {
    res.status(403).json({ error: "Only the creator wallet may approve this identity." });
    return;
  }
  if (body.data.chainId !== CHAIN_ID) {
    res.status(403).json({ error: "A valid creator approval challenge is required." });
    return;
  }
  const nonceHash = approvalNonceHash(body.data.nonce);
  const [challenge] = await db.select().from(genesisApprovalChallengesTable)
    .where(and(
      eq(genesisApprovalChallengesTable.providerJobId, job.id),
      eq(genesisApprovalChallengesTable.creatorWalletAddress, wallet),
      eq(genesisApprovalChallengesTable.nonceHash, nonceHash),
      isNull(genesisApprovalChallengesTable.consumedAt),
      gt(genesisApprovalChallengesTable.expiresAt, new Date()),
    )).limit(1);
  if (!challenge) {
    res.status(403).json({ error: "The creator approval challenge is invalid or expired." });
    return;
  }
  const expiresAt = new Date(body.data.expiresAt);
  const expiresAtText = expiresAt.toISOString();
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() !== challenge.expiresAt.getTime()
  ) {
    res.status(403).json({ error: "The creator approval challenge is invalid or expired." });
    return;
  }
  if (job.status !== "completed" || job.verificationStatus !== "verified" || !job.result) {
    res.status(409).json({ error: "Only an exactly verified Native Node result can be approved." });
    return;
  }
  let snapshot: ReturnType<typeof recomputeVerifiedGenesisJob>;
  try {
    snapshot = recomputeVerifiedGenesisJob(job, wallet);
  } catch {
    res.status(409).json({ error: "Only an exact verified Native Node result can be approved." });
    return;
  }
  const message = buildGenesisApprovalMessage({
    jobId: job.id,
    providerId: job.providerId,
    creatorWalletAddress: wallet,
    chainId: CHAIN_ID,
    expiresAt: expiresAtText,
    nonce: body.data.nonce,
    snapshot,
  });
  if (approvalMessageDigest(message) !== challenge.messageDigest) {
    res.status(409).json({ error: "The verified genesis snapshot changed; request a new challenge." });
    return;
  }
  let signatureValid = false;
  try {
    signatureValid = await verifyMessage({
      address: wallet as `0x${string}`,
      message,
      signature: body.data.signature as `0x${string}`,
    });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    res.status(403).json({ error: "Creator wallet signature verification failed." });
    return;
  }

  try {
    const approved = await db.transaction(async (tx) => {
      // Consume exactly this independent challenge in the same transaction
      // as the immutable snapshot insert. A second parallel approval cannot
      // pass the consumedAt guard.
      const [consumed] = await tx.update(genesisApprovalChallengesTable).set({
        consumedAt: new Date(),
      }).where(and(
        eq(genesisApprovalChallengesTable.id, challenge.id),
        eq(genesisApprovalChallengesTable.providerJobId, job.id),
        eq(genesisApprovalChallengesTable.nonceHash, nonceHash),
        isNull(genesisApprovalChallengesTable.consumedAt),
        gt(genesisApprovalChallengesTable.expiresAt, new Date()),
      )).returning();
      if (!consumed) throw new Error("Creator approval challenge was already consumed.");
      const [approvedJob] = await tx.update(providerJobsTable).set({
        creatorApprovedAt: new Date(),
      }).where(and(
        eq(providerJobsTable.id, job.id),
        eq(providerJobsTable.verificationStatus, "verified"),
        eq(providerJobsTable.status, "completed"),
        isNull(providerJobsTable.creatorApprovedAt),
      )).returning();
      if (!approvedJob) throw new Error("Creator approval has already been consumed.");
      const [recipe] = await tx.insert(approvedGenesisRecipesTable).values({
        id: randomUUID(),
        providerJobId: job.id,
        providerId: job.providerId,
        walletAddress: wallet,
        tokenName: snapshot.canonical.tokenName,
        symbol: snapshot.canonical.symbol,
        description: snapshot.canonical.description,
        seed: snapshot.canonical.seed,
        pixels: snapshot.canonical.pixels,
        engineVersion: snapshot.canonical.engine,
        cycles: snapshot.canonical.cyclesPerPixel,
        cpuDigest: snapshot.canonical.cpuDigest,
        imageDigest: snapshot.canonical.imageDigest,
        logoUri: null,
        pngDigest: snapshot.pngDigest,
        uploadStatus: "pending",
      }).returning();
      if (!recipe) throw new Error("Approved genesis snapshot was not persisted.");
      return { job: approvedJob, recipe };
    });
    res.json(GenerateGenesisArtResponse.parse(response(approved.job, approved.recipe)));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (code === "23505" || (error instanceof Error && error.message.includes("already consumed"))) {
      res.status(409).json({ error: "This creator approval has already been consumed." });
      return;
    }
    throw error;
  }
});

router.post("/genesis/art/:jobId/upload", async (req, res): Promise<void> => {
  const params = GetGenesisArtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid genesis workload ID." });
    return;
  }
  const [job] = await db.select().from(providerJobsTable)
    .where(eq(providerJobsTable.id, params.data.jobId)).limit(1);
  const [recipe] = job
    ? await db.select().from(approvedGenesisRecipesTable)
      .where(eq(approvedGenesisRecipesTable.providerJobId, job.id)).limit(1)
    : [];
  if (!job || !recipe) {
    res.status(404).json({ error: "Approved genesis recipe not found." });
    return;
  }
  // A successful retry is a read, not another Pinata upload.
  if (recipe.ipfsCid) {
    res.json(GenerateGenesisArtResponse.parse(response(job, recipe)));
    return;
  }
  const now = new Date();
  if (!canClaimGenesisUpload(recipe.uploadStatus, recipe.uploadStartedAt, now.getTime())) {
    res.status(409).json({ error: "Artifact upload is already in progress; retry shortly." });
    return;
  }
  // Claim before any network I/O. Only one request can transition a retryable
  // recipe to uploading; concurrent callers cannot pin duplicate CIDs.
  const [claimed] = await db.update(approvedGenesisRecipesTable).set({
    uploadStatus: "uploading",
    uploadStartedAt: now,
    uploadError: null,
  }).where(and(
    eq(approvedGenesisRecipesTable.id, recipe.id),
    isNull(approvedGenesisRecipesTable.ipfsCid),
    or(
      inArray(approvedGenesisRecipesTable.uploadStatus, ["pending", "failed"]),
      and(
        eq(approvedGenesisRecipesTable.uploadStatus, "uploading"),
        lte(
          approvedGenesisRecipesTable.uploadStartedAt,
          new Date(now.getTime() - GENESIS_UPLOAD_LEASE_MS),
        ),
      ),
    ),
  )).returning();
  if (!claimed) {
    const [current] = await db.select().from(approvedGenesisRecipesTable)
      .where(eq(approvedGenesisRecipesTable.id, recipe.id)).limit(1);
    if (current?.ipfsCid) {
      res.json(GenerateGenesisArtResponse.parse(response(job, current)));
      return;
    }
    res.status(409).json({ error: "Artifact upload is already in progress; retry shortly." });
    return;
  }
  try {
    const uploaded = await uploadGenesisSnapshot(claimed);
    const writeOnce = applyWriteOncePinataResult(claimed, uploaded);
    const [updated] = await db.update(approvedGenesisRecipesTable).set({
      ipfsCid: writeOnce.ipfsCid,
      logoUri: writeOnce.logoUri,
      uploadStatus: "uploaded",
      uploadStartedAt: null,
      uploadedAt: new Date(),
      uploadError: null,
    }).where(and(
      eq(approvedGenesisRecipesTable.id, claimed.id),
      eq(approvedGenesisRecipesTable.uploadStatus, "uploading"),
      eq(approvedGenesisRecipesTable.uploadStartedAt, claimed.uploadStartedAt!),
      isNull(approvedGenesisRecipesTable.ipfsCid),
    )).returning();
    const persisted = updated ?? (await db.select().from(approvedGenesisRecipesTable)
      .where(eq(approvedGenesisRecipesTable.id, claimed.id)).limit(1))[0];
    if (!persisted || persisted.uploadStatus !== "uploaded" || !persisted.ipfsCid) {
      throw new Error("Uploaded artifact was not persisted.");
    }
    res.json(GenerateGenesisArtResponse.parse(response(job, persisted)));
  } catch {
    await db.update(approvedGenesisRecipesTable).set({
      uploadStatus: "failed",
      uploadStartedAt: null,
      uploadError: "Artifact upload failed; retry upload.",
    }).where(and(
      eq(approvedGenesisRecipesTable.id, claimed.id),
      eq(approvedGenesisRecipesTable.uploadStatus, "uploading"),
      eq(approvedGenesisRecipesTable.uploadStartedAt, claimed.uploadStartedAt!),
      isNull(approvedGenesisRecipesTable.ipfsCid),
    ));
    res.status(502).json({ error: "Artifact upload is unavailable; retry upload." });
  }
});

router.get("/genesis/art/:jobId/png", async (req, res): Promise<void> => {
  const params = DownloadGenesisPngParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid genesis workload ID." });
    return;
  }
  const [recipe] = await db.select().from(approvedGenesisRecipesTable)
    .where(eq(approvedGenesisRecipesTable.providerJobId, params.data.jobId)).limit(1);
  if (!recipe) {
    res.status(404).json({ error: "Approved genesis recipe not found." });
    return;
  }
  const png = encodeGenesisPngWithDigest(recipe.pixels);
  if (recipe.pngDigest && recipe.pngDigest !== png.pngDigest) {
    res.status(409).json({ error: "Persisted genesis artifact digest does not match canonical PNG." });
    return;
  }
  res.type("png").set("Content-Disposition", `attachment; filename="${recipe.symbol.toLowerCase()}.png"`).send(png.png);
});

router.get("/genesis/deployment-proof/readiness", async (_req, res): Promise<void> => {
  try {
    await Promise.all([
      verifyGenesisDeploymentConfig(),
      assertGenesisV2RuntimeAssetsAvailable(),
    ]);
    res.json({ ready: true, reason: "Signer and reviewed Robinhood wiring verified.", chainId: CHAIN_ID });
  } catch {
    // Deliberately do not disclose whether a key, address, RPC, or wiring
    // check failed. Readiness is fail-closed and contains no secret material.
    res.status(503).json({ ready: false, reason: "Genesis deployment proof is not ready.", chainId: CHAIN_ID });
  }
});

router.get("/genesis/art/:jobId/deployment-proof", async (req, res): Promise<void> => {
  const params = GetGenesisArtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid genesis workload ID." });
    return;
  }
  const [recipe] = await db.select().from(approvedGenesisRecipesTable)
    .where(eq(approvedGenesisRecipesTable.providerJobId, params.data.jobId)).limit(1);
  if (!recipe) {
    res.status(404).json({ error: "Approved genesis recipe not found." });
    return;
  }
  res.json({ deploymentProof: recipe.deploymentProofJson
    ? deploymentProofResponse(recipe.deploymentProofJson as Record<string, unknown>, recipe)
    : null });
});

router.post("/genesis/art/:jobId/deployment-proof", async (req, res): Promise<void> => {
  const params = GetGenesisArtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid genesis workload ID." });
    return;
  }
  const suppliedKeys = req.body && typeof req.body === "object"
    ? Object.keys(req.body as Record<string, unknown>)
    : [];
  if (suppliedKeys.some((key) => [
    "registry", "factory", "coordinator", "protocol",
    "registryAddress", "factoryAddress", "coordinatorAddress", "protocolAddress",
  ].includes(key))) {
    res.status(400).json({ error: "Deployment addresses are server-configured and cannot be supplied by clients." });
    return;
  }
  const [recipe] = await db.select().from(approvedGenesisRecipesTable)
    .where(eq(approvedGenesisRecipesTable.providerJobId, params.data.jobId)).limit(1);
  if (!recipe) {
    res.status(404).json({ error: "Approved genesis recipe not found." });
    return;
  }
  if (recipe.deploymentProofJson && recipe.deploymentExpiry && recipe.deploymentExpiry > new Date()) {
    res.json(deploymentProofResponse(recipe.deploymentProofJson as Record<string, unknown>, recipe));
    return;
  }
  try {
    const signed = await issueGenesisDeploymentProof(recipe);
    const proof = {
      ...signed.proof,
      expiry: signed.proof.expiry.toString(),
      nonce: signed.proof.nonce.toString(),
    };
    const persisted = {
      proof,
      signature: signed.signature,
      digest: signed.digest,
      verifier: signed.verifier,
      issuedAt: signed.issuedAt.toISOString(),
      status: "issued",
    };
    const [updated] = await db.update(approvedGenesisRecipesTable).set({
      deploymentProofJson: persisted,
      deploymentConfigJson: {
        version: signed.config.version,
        registry: signed.config.registry,
        factory: signed.config.factory,
        coordinator: signed.config.coordinator,
        protocol: signed.config.protocol,
        verifier: signed.config.verifier,
        chainId: CHAIN_ID,
        official: {
          poolManager: signed.config.official.poolManager,
          positionManager: signed.config.official.positionManager,
          permit2: signed.config.official.permit2,
          weth: signed.config.official.weth,
          permissionMask: signed.config.official.permissionMask.toString(),
          fee: signed.config.official.fee.toString(),
          tickSpacing: signed.config.official.tickSpacing.toString(),
          sqrtPrice: signed.config.official.sqrtPrice.toString(),
        },
      },
      deploymentDigest: signed.digest,
      deploymentSignature: signed.signature,
      verifierAddress: signed.verifier,
      deploymentStatus: "issued",
      deploymentIssuedAt: signed.issuedAt,
      deploymentExpiry: signed.expiry,
    }).where(eq(approvedGenesisRecipesTable.id, recipe.id)).returning();
    const current = updated ?? recipe;
    res.json(deploymentProofResponse(persisted, current));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // Configuration and wiring failures must never turn into a partially
    // populated proof. The client receives a safe readiness failure only.
    if (!message.includes("Approved recipe artifact")) {
      res.status(503).json({ error: "Genesis deployment proof is not ready." });
      return;
    }
    res.status(409).json({ error: "Genesis recipe is not eligible for deployment proof." });
  }
});

router.get("/genesis/approved/:walletAddress", async (req, res): Promise<void> => {
  const parsed = GetApprovedGenesisRecipeParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide a valid creator wallet address." });
    return;
  }
  let wallet: string;
  try {
    wallet = getAddress(parsed.data.walletAddress);
  } catch {
    res.status(400).json({ error: "Provide a valid creator wallet address." });
    return;
  }
  const [recipe] = await db.select().from(approvedGenesisRecipesTable)
    .where(eq(approvedGenesisRecipesTable.walletAddress, wallet)).limit(1);
  if (!recipe) {
    res.status(404).json({ error: "No approved Native Node identity exists for this wallet." });
    return;
  }
  res.json(GetApprovedGenesisRecipeResponse.parse(approvedRecipeResponse(recipe)));
});

export default router;