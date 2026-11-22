import { Router, type IRouter, type Request, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import {
  auditEventsTable,
  db,
  demoBaselinesTable,
  demoOutboxTable,
  demoRecordOriginsTable,
  estimateDraftsTable,
  invoicesTable,
  jobsTable,
  leadsTable,
  productsTable,
  proposalsTable,
  tourProgressTable,
  trainingAudioCacheTable,
  trainingPreferencesTable,
  trainingRunsTable,
} from "@workspace/db";
import { currentWorkspace, workspaceEnvironment } from "@workspace/db/workspace";
import { audit } from "../lib/auth";
import { domainRoute } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { PAGE_GUIDES, TRAINING_MANIFEST_VERSION, TRAINING_MISSIONS, canCompleteTrainingStep, findTrainingStep, type TrainingStep } from "../lib/training";
import { hasMeasuredRoom, practiceCustomerName, trainingPracticeAccess } from "../lib/training-practice";
import { requireOwner } from "../middlewares/auth";
import { SEED_INVOICES, SEED_JOBS, SEED_LEADS, SEED_PRODUCTS, SEED_PROPOSALS } from "../lib/seed-data";
import { generateTutorialNarration, getTutorialNarrationStatus } from "../lib/tutorial-narration";
import { createTrainingAudioHandler } from "../lib/training-audio-handler";

const router: IRouter = Router();

function canUseMission(req: Express.Request, role: string) {
  return req.auth?.role === role;
}

function practiceAccess(req: Request) {
  return trainingPracticeAccess(workspaceEnvironment(), req.get("host") ?? "", !currentWorkspace());
}

const requirePractice: RequestHandler = (req, res, next) => {
  if (!practiceAccess(req).enabled) {
    res.status(403).json({ error: "Interactive training is available in the separate practice workspace." });
    return;
  }
  next();
};

const requireLegacyBaseline: RequestHandler = (req, res, next) => {
  if (!practiceAccess(req).enabled || workspaceEnvironment().ALLOW_DEMO_SEED !== "true") {
    res.status(404).json({ error: "Demo baseline management is unavailable." });
    return;
  }
  next();
};

type TrainingRun = typeof trainingRunsTable.$inferSelect;
type TrainingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function inMissionTransaction<T>(userId: string, missionKey: string, task: (tx: TrainingTransaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["training.mission", userId, missionKey])}, 0))`);
    return task(tx);
  });
}

async function getMissionRun(tx: TrainingTransaction, userId: string, missionKey: string, runId: string) {
  const [run] = await tx.select().from(trainingRunsTable).where(and(
    eq(trainingRunsTable.id, runId), eq(trainingRunsTable.userId, userId), eq(trainingRunsTable.missionKey, missionKey),
  )).limit(1);
  if (!run) throw new DomainError(404, "Training run not found");
  return run;
}

async function deactivateOtherRuns(tx: TrainingTransaction, userId: string, missionKey: string, now: string, status: "paused" | "dismissed", keepRun?: string) {
  await tx.update(trainingRunsTable).set({ status, updatedAt: now }).where(and(
    eq(trainingRunsTable.userId, userId), eq(trainingRunsTable.missionKey, missionKey), eq(trainingRunsTable.status, "active"),
    keepRun ? ne(trainingRunsTable.id, keepRun) : undefined,
  ));
}

function publicRun(run: TrainingRun) {
  const { practiceData: _private, ...values } = run;
  return { ...values, practiceCustomerName: practiceCustomerName(run) };
}

async function hasPracticeOutcome(tx: TrainingTransaction, step: TrainingStep, run: TrainingRun) {
  if (!step.outcome) return false;
  const name = practiceCustomerName(run);
  if (step.outcome === "lead") {
    const [lead] = await tx.select({ id: leadsTable.id }).from(leadsTable).where(and(
      eq(leadsTable.customerName, name), eq(leadsTable.phone, ""), eq(leadsTable.email, ""),
      gte(leadsTable.createdAt, run.startedAt),
    )).limit(1);
    return Boolean(lead);
  }

  const drafts = await tx.select({ inputs: estimateDraftsTable.inputs, proposalId: proposalsTable.id })
    .from(estimateDraftsTable).leftJoin(proposalsTable, and(
      eq(proposalsTable.id, estimateDraftsTable.convertedProposalId),
      eq(proposalsTable.customerName, name), gte(proposalsTable.createdAt, run.startedAt),
    )).where(and(
      eq(estimateDraftsTable.ownerUserId, run.userId), gte(estimateDraftsTable.createdAt, run.startedAt),
      sql`${estimateDraftsTable.inputs}->>'customerName' = ${name}`,
    ));
  return drafts.some((draft) => hasMeasuredRoom(draft.inputs) && (step.outcome !== "proposal" || Boolean(draft.proposalId)));
}

async function saveLegacyProgress(tx: TrainingTransaction, run: TrainingRun) {
  const { userId, missionKey, currentStep, status, checkpoints, startedAt, completedAt, updatedAt } = run;
  const [existing] = await tx.select().from(tourProgressTable)
    .where(and(eq(tourProgressTable.userId, userId), eq(tourProgressTable.missionKey, missionKey))).limit(1);
  const values = { currentStep, status, checkpoints, startedAt, completedAt, updatedAt };
  if (existing) await tx.update(tourProgressTable).set(values).where(eq(tourProgressTable.id, existing.id));
  else await tx.insert(tourProgressTable).values({ id: randomUUID(), userId, missionKey, ...values });
}

router.get("/demo/status", async (req, res) => {
  const practice = practiceAccess(req);
  const recentRuns: Promise<TrainingRun[]> = practice.enabled
    ? db.select().from(trainingRunsTable).where(eq(trainingRunsTable.userId, req.auth!.userId)).orderBy(desc(trainingRunsTable.updatedAt))
    : Promise.resolve([]);
  const [[baseline], progress, runs, [savedPreferences]] = await Promise.all([
    practice.enabled ? db.select().from(demoBaselinesTable).where(eq(demoBaselinesTable.active, true)).limit(1) : [],
    practice.enabled ? db.select().from(tourProgressTable).where(eq(tourProgressTable.userId, req.auth!.userId)) : [],
    recentRuns,
    db.select().from(trainingPreferencesTable).where(eq(trainingPreferencesTable.userId, req.auth!.userId)).limit(1),
  ]);
  const role = req.auth!.role;
  const missions = TRAINING_MISSIONS.filter((mission) => req.auth!.actualRole === "owner" || mission.role === role);
  const pageGuides = PAGE_GUIDES.filter((guide) => guide.role.includes(role));
  res.json({
    enabled: true,
    practice,
    manifestVersion: TRAINING_MANIFEST_VERSION,
    baseline: baseline ?? null,
    missions: practice.enabled ? missions : [],
    lessons: practice.enabled ? [] : missions.map((mission) => ({
      ...mission, steps: mission.steps.map(({ id, title, explanation }) => ({ id, title, explanation })),
    })),
    pageGuides,
    progress,
    runs: runs.filter((run) => run.manifestVersion === TRAINING_MANIFEST_VERSION).map(publicRun),
    preferences: savedPreferences ?? { userId: req.auth!.userId, voiceEnabled: false, captionsEnabled: true, welcomeDismissed: false },
    narration: getTutorialNarrationStatus(),
  });
});

router.get("/demo/outbox", async (_req, res) => {
  res.json(await db.select().from(demoOutboxTable).orderBy(desc(demoOutboxTable.createdAt)).limit(100));
});

router.post("/demo/training/reset", requireOwner, requirePractice, async (req, res) => {
  await db.transaction(async (tx) => {
    await tx.delete(trainingRunsTable).where(eq(trainingRunsTable.userId, req.auth!.userId));
    await tx.delete(tourProgressTable).where(eq(tourProgressTable.userId, req.auth!.userId));
    await tx.delete(trainingPreferencesTable).where(eq(trainingPreferencesTable.userId, req.auth!.userId));
  });
  await audit("training.reset", { userId: req.auth!.userId, entityType: "training", entityId: req.auth!.userId, ip: req.ip, details: { invitationRestored: true } });
  res.json({ ok: true, invitationRestored: true });
});

router.put("/demo/preferences", async (req, res) => {
  const now = new Date().toISOString();
  const [existing] = await db.select().from(trainingPreferencesTable)
    .where(eq(trainingPreferencesTable.userId, req.auth!.userId)).limit(1);
  const values = {
    voiceEnabled: typeof req.body?.voiceEnabled === "boolean" ? req.body.voiceEnabled : existing?.voiceEnabled ?? false,
    captionsEnabled: true,
    welcomeDismissed: typeof req.body?.welcomeDismissed === "boolean" ? req.body.welcomeDismissed : existing?.welcomeDismissed ?? false,
    updatedAt: now,
  };
  if (existing) await db.update(trainingPreferencesTable).set(values).where(eq(trainingPreferencesTable.userId, req.auth!.userId));
  else await db.insert(trainingPreferencesTable).values({ userId: req.auth!.userId, ...values });
  await audit("training.preferences.updated", { userId: req.auth!.userId, entityType: "training_preferences", entityId: req.auth!.userId, ip: req.ip, details: values });
  res.json({ userId: req.auth!.userId, ...values });
});

router.use("/demo/missions", requirePractice);

router.post("/demo/missions/:key/start", domainRoute(async (req, res) => {
  const mission = TRAINING_MISSIONS.find((item) => item.key === req.params.key);
  if (!mission) { res.status(404).json({ error: "Mission not found" }); return; }
  if (!canUseMission(req, mission.role)) { res.status(403).json({ error: `Switch to the ${mission.role} perspective to start this mission` }); return; }
  const userId = req.auth!.userId;
  const voiceEnabled = req.body?.voiceEnabled === true;
  const run = await inMissionTransaction(userId, mission.key, async (tx) => {
    const now = new Date().toISOString();
    await deactivateOtherRuns(tx, userId, mission.key, now, "dismissed");
    const [created] = await tx.insert(trainingRunsTable).values({
      id: randomUUID(),
      userId,
      missionKey: mission.key,
      manifestVersion: TRAINING_MANIFEST_VERSION,
      status: "active",
      currentStep: 0,
      voiceEnabled,
      checkpoints: [],
      practiceData: { environment: "practice" },
      startedAt: now,
      updatedAt: now,
    }).returning();
    const nextPreferences = { voiceEnabled, captionsEnabled: true, welcomeDismissed: true, updatedAt: now };
    await tx.insert(trainingPreferencesTable).values({ userId, ...nextPreferences })
      .onConflictDoUpdate({ target: trainingPreferencesTable.userId, set: nextPreferences });
    await saveLegacyProgress(tx, created);
    return created;
  });
  await audit("training.mission.started", { userId, entityType: "training_run", entityId: run.id, ip: req.ip, details: { missionKey: mission.key, voiceEnabled, manifestVersion: TRAINING_MANIFEST_VERSION } });
  res.status(201).json(publicRun(run));
}));

router.put("/demo/missions/:key", domainRoute(async (req, res) => {
  const mission = TRAINING_MISSIONS.find((item) => item.key === req.params.key);
  if (!mission) { res.status(404).json({ error: "Mission not found" }); return; }
  if (!canUseMission(req, mission.role)) { res.status(403).json({ error: "Switch to the mission's role to continue." }); return; }
  const userId = req.auth!.userId;
  const resumed = await inMissionTransaction(userId, mission.key, async (tx) => {
    const run = await getMissionRun(tx, userId, mission.key, String(req.body?.runId ?? ""));
    const currentStep = req.body?.currentStep ?? run.currentStep;
    if (run.manifestVersion !== TRAINING_MANIFEST_VERSION || !["active", "paused"].includes(run.status) ||
      req.body?.status !== "active" || !Number.isInteger(currentStep) || currentStep < Math.max(0, run.currentStep - 1) || currentStep > run.currentStep) {
      throw new DomainError(409, "Resume this mission or verify its current checkpoint to advance.");
    }
    const now = new Date().toISOString();
    await deactivateOtherRuns(tx, userId, mission.key, now, "paused", run.id);
    const [updated] = await tx.update(trainingRunsTable).set({ status: "active", currentStep, updatedAt: now })
      .where(eq(trainingRunsTable.id, run.id)).returning();
    await saveLegacyProgress(tx, updated);
    return updated;
  });
  res.json(publicRun(resumed));
}));

router.post("/demo/missions/:key/verify", domainRoute(async (req, res) => {
  const mission = TRAINING_MISSIONS.find((item) => item.key === req.params.key);
  if (!mission) { res.status(404).json({ error: "Mission not found" }); return; }
  if (!canUseMission(req, mission.role)) { res.status(403).json({ error: "Switch to the mission's role to continue." }); return; }
  const userId = req.auth!.userId;
  const runId = String(req.body?.runId ?? "");
  const skipped = req.body?.skipped === true;
  const result = await inMissionTransaction(userId, mission.key, async (tx) => {
    const run = await getMissionRun(tx, userId, mission.key, runId);
    if (run.manifestVersion !== TRAINING_MANIFEST_VERSION) throw new DomainError(409, "Training content changed. Restart this mission to continue.");
    if (run.status !== "active") throw new DomainError(409, "Resume this mission before verifying a checkpoint.");
    const step = mission.steps[run.currentStep];
    if (!step || step.id !== req.body?.stepId) throw new DomainError(409, "This is not the active training step");
    const persistedOutcome = step.kind === "action" && !skipped && (run.checkpoints.includes(step.id) || await hasPracticeOutcome(tx, step, run));
    if (!canCompleteTrainingStep(step, persistedOutcome, skipped)) return { stepId: step.id, run: null };
    const checkpoint = skipped ? `${step.id}:skipped` : step.id;
    const checkpoints = Array.from(new Set([...run.checkpoints.filter((item) => item !== `${step.id}:skipped`), run.checkpoints.includes(step.id) ? step.id : checkpoint]));
    const lastStep = run.currentStep >= mission.steps.length - 1;
    const now = new Date().toISOString();
    const [updated] = await tx.update(trainingRunsTable).set({
      checkpoints, currentStep: lastStep ? run.currentStep : run.currentStep + 1,
      status: lastStep ? "completed" : "active", completedAt: lastStep ? now : null, updatedAt: now,
    }).where(eq(trainingRunsTable.id, run.id)).returning();
    await saveLegacyProgress(tx, updated);
    return { stepId: step.id, run: updated };
  });
  if (!result.run) {
    await audit("training.step.validation_failed", { userId, entityType: "training_run", entityId: runId, ip: req.ip, details: { missionKey: mission.key, stepId: result.stepId, reason: "practice_record_missing" } });
    res.status(422).json({ error: "The expected practice record is missing. Save it using the exact practice customer name and try again." });
    return;
  }
  const complete = result.run.status === "completed";
  await audit(complete ? "training.mission.completed" : "training.step.verified", { userId, entityType: "training_run", entityId: runId, ip: req.ip, details: { missionKey: mission.key, stepId: result.stepId, skipped } });
  res.json({ ...publicRun(result.run), verifiedStepId: skipped ? null : result.stepId, complete });
}));

router.post("/demo/missions/:key/exit", domainRoute(async (req, res) => {
  const userId = req.auth!.userId;
  const missionKey = String(req.params.key ?? "");
  const runId = String(req.body?.runId ?? "");
  const status = req.body?.discard === true ? "dismissed" : "paused";
  const exited = await inMissionTransaction(userId, missionKey, async (tx) => {
    const run = await getMissionRun(tx, userId, missionKey, runId);
    if (run.status === "completed" || run.status === "dismissed" || run.status === status) return run;
    const [updated] = await tx.update(trainingRunsTable).set({ status, updatedAt: new Date().toISOString() })
      .where(eq(trainingRunsTable.id, run.id)).returning();
    if (run.status === "active") await saveLegacyProgress(tx, updated);
    return updated;
  });
  if (exited.status === status) await audit(status === "paused" ? "training.mission.paused" : "training.mission.exited", { userId, entityType: "training_run", entityId: runId, ip: req.ip, details: { missionKey } });
  res.json(publicRun(exited));
}));

router.post("/demo/missions/:key/restart", domainRoute(async (req, res) => {
  const mission = TRAINING_MISSIONS.find((item) => item.key === req.params.key);
  if (!mission) { res.status(404).json({ error: "Mission not found" }); return; }
  if (!canUseMission(req, mission.role)) { res.status(403).json({ error: "Switch to the mission's role to restart." }); return; }
  const userId = req.auth!.userId;
  const restarted = await inMissionTransaction(userId, mission.key, async (tx) => {
    const run = await getMissionRun(tx, userId, mission.key, String(req.body?.runId ?? ""));
    const now = new Date().toISOString();
    await deactivateOtherRuns(tx, userId, mission.key, now, "paused", run.id);
    const [updated] = await tx.update(trainingRunsTable).set({
      manifestVersion: TRAINING_MANIFEST_VERSION, status: "active", currentStep: 0, checkpoints: [],
      practiceData: { environment: "practice" }, startedAt: now, completedAt: null, updatedAt: now,
    }).where(eq(trainingRunsTable.id, run.id)).returning();
    await saveLegacyProgress(tx, updated);
    return updated;
  });
  await audit("training.mission.restarted", { userId, entityType: "training_run", entityId: restarted.id, ip: req.ip, details: { missionKey: mission.key } });
  res.json(publicRun(restarted));
}));

router.get("/demo/audio/:stepId", createTrainingAudioHandler({
  manifestVersion: TRAINING_MANIFEST_VERSION,
  findScript: (stepId) => findTrainingStep(stepId)?.step.narration,
  getStatus: getTutorialNarrationStatus,
  generate: generateTutorialNarration,
  readCache: async (scriptHash) => {
    const [cached] = await db.select().from(trainingAudioCacheTable).where(eq(trainingAudioCacheTable.scriptHash, scriptHash)).limit(1);
    return cached;
  },
  writeCache: async (audio) => {
    await db.insert(trainingAudioCacheTable).values({ ...audio, id: randomUUID(), createdAt: new Date().toISOString() }).onConflictDoNothing();
  },
  auditGenerated: async (req, stepId, details) => {
    await audit("training.narration.generated", { userId: req.auth!.userId, entityType: "training_audio", entityId: stepId, ip: req.ip, details });
  },
}));

router.get("/demo/reset/preview", requireOwner, requireLegacyBaseline, async (_req, res) => {
  const origins = await db.select().from(demoRecordOriginsTable);
  const counts = origins.reduce<Record<string, number>>((acc, row) => { acc[row.entityType] = (acc[row.entityType] ?? 0) + 1; return acc; }, {});
  res.json({ demoRecords: counts, teamRecordsPreserved: true, transactional: true });
});

router.post("/demo/reset", requireOwner, requireLegacyBaseline, async (req, res) => {
  const scope = String(req.body?.scope ?? "all");
  if (scope === "factory" && req.body?.confirmation !== "DELETE ALL DATA") { res.status(400).json({ error: "Type DELETE ALL DATA to confirm a factory reset" }); return; }
  await db.transaction(async (tx) => {
    if (scope === "factory") {
      await tx.delete(invoicesTable); await tx.delete(proposalsTable); await tx.delete(leadsTable); await tx.delete(jobsTable); await tx.delete(productsTable); await tx.delete(tourProgressTable); await tx.delete(trainingRunsTable); await tx.delete(trainingPreferencesTable); await tx.delete(trainingAudioCacheTable); await tx.delete(demoRecordOriginsTable);
    } else if (scope === "all") {
      const replace = async (table: any, rows: any[]) => { const ids = rows.map((row) => row.id); if (ids.length) await tx.delete(table).where(inArray(table.id, ids)); if (rows.length) await tx.insert(table).values(rows); };
      await replace(invoicesTable, SEED_INVOICES); await replace(proposalsTable, SEED_PROPOSALS); await replace(leadsTable, SEED_LEADS); await replace(jobsTable, SEED_JOBS); await replace(productsTable, SEED_PRODUCTS); await tx.delete(tourProgressTable); await tx.delete(trainingRunsTable); await tx.delete(trainingPreferencesTable);
    } else {
      const heroIndex: Record<string, string> = { "residential-lvp": "1", "pet-carpet": "2", "hardwood-risk": "3", "commercial-lvt": "4" };
      const jobId = heroIndex[scope];
      if (!jobId) throw new Error("Unknown demo scenario");
      const job = SEED_JOBS.filter((row) => row.id === jobId); const proposals = SEED_PROPOSALS.filter((row) => row.jobId === jobId); const invoices = SEED_INVOICES.filter((row) => row.jobId === jobId);
      if (invoices.length) { await tx.delete(invoicesTable).where(inArray(invoicesTable.id, invoices.map((row) => row.id))); await tx.insert(invoicesTable).values(invoices); }
      if (proposals.length) { await tx.delete(proposalsTable).where(inArray(proposalsTable.id, proposals.map((row) => row.id))); await tx.insert(proposalsTable).values(proposals); }
      await tx.delete(jobsTable).where(eq(jobsTable.id, jobId)); await tx.insert(jobsTable).values(job); await tx.delete(tourProgressTable).where(eq(tourProgressTable.missionKey, scope));
    }
    await tx.insert(auditEventsTable).values({ id: randomUUID(), actorUserId: req.auth!.userId, action: "demo.reset", entityType: "demo", entityId: scope, details: { scope, teamRecordsPreserved: scope !== "factory" }, createdAt: new Date().toISOString(), ipAddress: req.ip ?? "" });
  });
  res.json({ ok: true, scope, teamRecordsPreserved: scope !== "factory", message: scope === "factory" ? "All business data was removed." : "Curated records and training progress were restored from the active baseline." });
});

export default router;
