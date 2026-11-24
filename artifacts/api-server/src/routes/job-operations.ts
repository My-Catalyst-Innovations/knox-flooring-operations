import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import {
  db,
  jobsTable,
  invoicesTable,
  crewsTable,
  crewBookingsTable,
  jobCallbacksTable,
  jobMaterialsTable,
  jobUpdatesTable,
  laborEntriesTable,
  settingsTable,
  usersTable,
  inventoryMovementsTable,
  inventoryStockCountsTable,
  warehousesTable,
  warehouseBinsTable,
  auditEventsTable,
} from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { domainRoute, parse, revision, id } from "../lib/domain-http";
import {
  assertRevision,
  eventDate,
  withinPeriod,
  DomainError,
} from "../lib/operations-rules";
import { audit } from "../lib/auth";
import { reportMaterialUsage } from "../lib/report-material-usage";
import { jobMigrationCutover } from "../lib/job-cutover";
import { stagnantInventory } from "../lib/stagnant-inventory";
import {
  completionTimeliness,
  inventoryActivity,
  invoiceAging,
  isReportDate,
  reportBusinessDate,
  shiftReportDate,
  stockAuditSummary,
  upcomingInstallationJobs,
} from "../lib/report-metrics";
import {
  installationMaterialMessages,
  jobReadiness,
  updateJobWithReadiness,
  JOB_STAGES,
} from "../lib/job-readiness";
import { convertLead } from "../lib/conversions";

const router = Router();
const jobUpdateFields = {
  id: jobUpdatesTable.id,
  authorName: jobUpdatesTable.authorName,
  message: jobUpdatesTable.message,
  createdAt: jobUpdatesTable.createdAt,
};
router.get(
  "/workspace-brand",
  domainRoute(async (_req, res) => {
    const [s] = await db.select().from(settingsTable).limit(1);
    res.json({
      companyName: s?.companyName ?? "",
      companyLogoUrl: s?.companyLogoUrl ?? null,
      customerAccentColor: s?.customerAccentColor ?? "#7B00F5",
      phone: s?.phone ?? "",
      email: s?.email ?? "",
      website: s?.website ?? "",
      address: s?.address ?? "",
    });
  }),
);
router.post(
  "/leads/:id/convert",
  requireRole("owner", "sales"),
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({ revision: revision.optional() }),
      req.body ?? {},
    );
    res.json(
      await db.transaction((tx) => convertLead(tx, id(req), data.revision)),
    );
  }),
);
router.get(
  "/jobs/:id/readiness",
  domainRoute(async (req, res) => {
    const stage = String(req.query.targetStage ?? "Scheduled");
    res.json(await db.transaction((tx) => jobReadiness(tx, id(req), stage)));
  }),
);
router.get(
  "/jobs/:id/updates",
  domainRoute(async (req, res) => {
    const updates = await db.select(jobUpdateFields).from(jobUpdatesTable)
      .where(eq(jobUpdatesTable.jobId, id(req)))
      .orderBy(desc(jobUpdatesTable.createdAt), desc(jobUpdatesTable.id)).limit(50);
    res.json(updates);
  }),
);
router.post(
  "/jobs/:id/updates",
  domainRoute(async (req, res) => {
    const jobId = id(req);
    const authorId = req.auth!.userId;
    const data = parse(z.object({ id: z.string().uuid(), message: z.string().trim().min(1).max(1500) }), req.body);
    const result = await db.transaction(async (tx) => {
      const [job] = await tx.select({ id: jobsTable.id }).from(jobsTable)
        .where(eq(jobsTable.id, jobId)).for("key share");
      if (!job) throw new DomainError(404, "Job not found");
      const [author] = await tx.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, authorId));
      if (!author) throw new DomainError(403, "The author could not be verified.");
      const [created] = await tx.insert(jobUpdatesTable).values({
        ...data, jobId, authorId, authorName: author.name, createdAt: new Date().toISOString(),
      }).onConflictDoNothing().returning(jobUpdateFields);
      if (created) return { status: 201, update: created };
      const [existing] = await tx.select().from(jobUpdatesTable).where(eq(jobUpdatesTable.id, data.id));
      if (!existing || existing.authorId !== authorId || existing.jobId !== jobId || existing.message !== data.message) {
        throw new DomainError(409, "This update ID already belongs to a different entry.");
      }
      return { status: 200, update: { id: existing.id, authorName: existing.authorName, message: existing.message, createdAt: existing.createdAt } };
    });
    res.status(result.status).json(result.update);
  }),
);
router.get(
  "/jobs/:id/entry-context",
  domainRoute(async (req, res) => {
    if (
      !(
        await db
          .select({ id: jobsTable.id })
          .from(jobsTable)
          .where(eq(jobsTable.id, id(req)))
      )[0]
    )
      throw new DomainError(404, "Job not found");
    const [crews, bookings, callbacks, materials] = await Promise.all([
      db.select().from(crewsTable),
      db
        .select()
        .from(crewBookingsTable)
        .where(eq(crewBookingsTable.jobId, id(req))),
      db
        .select()
        .from(jobCallbacksTable)
        .where(eq(jobCallbacksTable.jobId, id(req))),
      db.select({ id: jobMaterialsTable.id, name: jobMaterialsTable.name, quantity: jobMaterialsTable.quantity, unit: jobMaterialsTable.unit })
        .from(jobMaterialsTable).where(eq(jobMaterialsTable.jobId, id(req))),
    ]);
    res.json({
      crews: crews
        .filter((c) =>
          req.auth!.role === "installer"
            ? bookings.some((b) => b.crewId === c.id)
            : c.active || bookings.some((b) => b.crewId === c.id),
        )
        .map((c) => ({ id: c.id, name: c.name })),
      bookings: bookings.map((b) => ({
        id: b.id,
        crewId: b.crewId,
        startAt: b.startAt,
        endAt: b.endAt,
        status: b.status,
      })),
      callbacks: callbacks.map((c) => ({
        id: c.id,
        reason: c.reason,
        status: c.status,
      })),
      materials,
    });
  }),
);
router.post(
  "/jobs/:id/transition",
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({
        revision,
        targetStage: z.string().refine((v) => JOB_STAGES.includes(v)),
        overrideReason: z.string().trim().min(1).max(2000).optional(),
        completionChecklist: z.record(z.string(), z.boolean()).optional(),
      }),
      req.body,
    );
    res.json(
      await db.transaction((tx) =>
        updateJobWithReadiness(
          tx,
          id(req),
          {
            status: data.targetStage,
            ...(data.completionChecklist
              ? { completionChecklist: data.completionChecklist }
              : {}),
          },
          req.auth!,
          data.revision,
          data.overrideReason,
        ),
      ),
    );
  }),
);
router.put(
  "/jobs/:id/committed-completion",
  requireRole("owner"),
  domainRoute(async (req, res) => {
    const data = parse(
      z.object({
        revision,
        date: z
          .string()
          .refine(isReportDate, "Enter a valid calendar date.")
          .nullable(),
      }),
      req.body,
    );
    const saved = await db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, id(req)))
        .for("update");
      if (!job) throw new DomainError(404, "Job not found.");
      assertRevision(job.revision, data.revision);
      if (
        ["Completed", "Invoiced"].includes(job.status) ||
        eventDate(job, "completed")
      ) {
        throw new DomainError(
          409,
          "The completion commitment is locked after recorded completion.",
        );
      }
      const now = new Date().toISOString();
      if (job.committedCompletionDate === data.date) {
        return {
          date: job.committedCompletionDate,
          recordedAt: job.committedCompletionRecordedAt,
          revision: job.revision,
        };
      }
      const nextRevision = job.revision + 1;
      const recordedAt = data.date ? now : null;
      await tx
        .update(jobsTable)
        .set({
          committedCompletionDate: data.date,
          committedCompletionRecordedAt: recordedAt,
          revision: nextRevision,
          updatedAt: now,
        })
        .where(eq(jobsTable.id, job.id));
      await audit(
        "job.completion_commitment_changed",
        {
          userId: req.auth!.userId,
          entityType: "job",
          entityId: job.id,
          ip: req.ip,
          details: {
            previousDate: job.committedCompletionDate,
            previousRecordedAt: job.committedCompletionRecordedAt,
            date: data.date,
            recordedAt,
          },
        },
        tx,
      );
      return { date: data.date, recordedAt, revision: nextRevision };
    });
    res.json(saved);
  }),
);

function boundary(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Convert midnight in the business timezone, including daylight-saving offsets.
    const wall = Date.parse(value + "T00:00:00Z");
    if (!isReportDate(value))
      throw new DomainError(400, "Use a valid calendar date.");
    let result = wall;
    for (let i = 0; i < 2; i++) {
      const offset =
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          timeZoneName: "longOffset",
        })
          .formatToParts(new Date(result))
          .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
      const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset);
      const minutes = match
        ? (Number(match[2]) * 60 + Number(match[3])) *
          (match[1] === "+" ? 1 : -1)
        : 0;
      result = wall - minutes * 60000;
    }
    return new Date(result).toISOString();
  }
  if (!Number.isFinite(Date.parse(value)))
    throw new DomainError(400, "Use valid from/to dates.");
  return new Date(value).toISOString();
}
router.get("/metrics/stagnant-inventory", requireRole("owner"), domainRoute(async (_req, res) => {
  res.json(await stagnantInventory());
}));

router.get(
  "/metrics",
  requireRole("owner"),
  domainRoute(async (req, res) => {
    const today = new Date();
    const businessToday = reportBusinessDate(today);
    const month = businessToday.slice(0, 7);
    const from = boundary(String(req.query.from ?? month + "-01"));
    const defaultTo = shiftReportDate(businessToday, 1);
    const to = boundary(String(req.query.to ?? defaultTo));
    if (Date.parse(from) >= Date.parse(to))
      throw new DomainError(400, "The period must end after it starts.");
    if (Date.parse(to) - Date.parse(from) > 366 * 86400000)
      throw new DomainError(400, "Choose a period of one year or less.");
    const oldestMovement = boundary(shiftReportDate(businessToday, -89));
    const recentMovementCount = (days: number) =>
      sql<number>`count(*) filter (where ${inventoryMovementsTable.createdAt} >= ${boundary(shiftReportDate(businessToday, 1 - days))})`.mapWith(
        Number,
      );
    const counts = inventoryStockCountsTable;
    const postedInPeriod = and(eq(counts.status, "Reconciled"), gte(counts.resolvedAt, from), lt(counts.resolvedAt, to));
    const jobId = sql<string | null>`${auditEventsTable.details}->>'jobId'`;
    const jobNumber = sql<string | null>`${auditEventsTable.details}->>'jobNumber'`;
    const crewId = sql<string | null>`${auditEventsTable.details}->>'crewId'`;
    const crewName = sql<string | null>`${auditEventsTable.details}->>'crewName'`;
    const [
      jobs,
      invoices,
      crews,
      bookings,
      callbacks,
      labor,
      movements,
      audits,
      postedCounts,
    ] = await Promise.all([
      db
        .select()
        .from(jobsTable),
      db
        .select({
          id: invoicesTable.id,
          invoiceNumber: invoicesTable.invoiceNumber,
          customerName: invoicesTable.customerName,
          status: invoicesTable.status,
          total: invoicesTable.total,
          balanceAmount: invoicesTable.balanceAmount,
          issueDate: invoicesTable.issueDate,
          dueDate: invoicesTable.dueDate,
        })
        .from(invoicesTable),
      db.select().from(crewsTable),
      db.select().from(crewBookingsTable),
      db.select().from(jobCallbacksTable),
      db.select().from(laborEntriesTable),
      db
        .select({
          kind: inventoryMovementsTable.kind,
          last30: recentMovementCount(30),
          last60: recentMovementCount(60),
          last90: sql<number>`count(*)`.mapWith(Number),
        })
        .from(inventoryMovementsTable)
        .where(
          and(
            gte(inventoryMovementsTable.createdAt, oldestMovement),
            lte(inventoryMovementsTable.createdAt, today.toISOString()),
          ),
        )
        .groupBy(inventoryMovementsTable.kind),
      db
        .select({
          productId: counts.productId,
          sku: counts.sku,
          productName: counts.productName,
          unit: counts.unit,
          jobId, jobNumber, crewId, crewName,
          entries: sql<number>`count(*)`.mapWith(Number),
          quantity:
            sql<number>`round(sum(${counts.bookedQuantity}::numeric - ${counts.countedQuantity}::numeric), 6)`.mapWith(
              Number,
            ),
        })
        .from(counts)
        .leftJoin(auditEventsTable, and(eq(auditEventsTable.entityId, counts.id), eq(auditEventsTable.entityType, "stock_count"), eq(auditEventsTable.action, "inventory.waste_attributed")))
        .where(and(postedInPeriod, eq(counts.reason, "waste")))
        .groupBy(counts.productId, counts.sku, counts.productName, counts.unit, jobId, jobNumber, crewId, crewName)
        .orderBy(asc(counts.productName), asc(counts.sku), asc(counts.unit)),
      db.select({
        id: counts.id, sku: counts.sku, productName: counts.productName, unit: counts.unit,
        warehouseId: counts.warehouseId, warehouseName: warehousesTable.name,
        binCode: warehouseBinsTable.code, postedAt: counts.resolvedAt,
        bookedQuantity: counts.bookedQuantity, countedQuantity: counts.countedQuantity,
      })
        .from(counts)
        .innerJoin(warehousesTable, eq(counts.warehouseId, warehousesTable.id))
        .leftJoin(warehouseBinsTable, eq(counts.binId, warehouseBinsTable.id))
        .where(and(postedInPeriod, eq(counts.reason, "count")))
        .orderBy(desc(counts.resolvedAt), desc(counts.id)),
    ]);
    const installationUntil = shiftReportDate(businessToday, 14);
    const { confirmedJobIds, needsCrewJobIds, datesByJob } = upcomingInstallationJobs(
      jobs,
      bookings,
      new Set(crews.filter((crew) => crew.active).map((crew) => crew.id)),
      today,
      new Date(boundary(installationUntil)),
    );
    const materialIssues =
      confirmedJobIds.length > 0
        ? await db.transaction((tx) =>
            installationMaterialMessages(tx, confirmedJobIds),
          )
        : null;
    const confirmed = new Set(confirmedJobIds);
    const missingCrew = new Set(needsCrewJobIds);
    const jobSource = (job: { id: string; jobNumber: string; customerName: string }) =>
      ({ jobId: job.id, jobNumber: job.jobNumber, customerName: job.customerName });
    const installations = jobs.filter((job) => confirmed.has(job.id) || missingCrew.has(job.id)).map((job) => {
      const issues = materialIssues?.get(job.id)?.map(({ message }) => message) ?? [];
      const status = missingCrew.has(job.id) ? "needsCrew" : issues.length > 0 ? "materialsNeedAttention" : "ready";
      return { ...jobSource(job), scheduledOn: datesByJob.get(job.id) ?? null, status, issues };
    }).sort((a, b) => (a.scheduledOn ?? "").localeCompare(b.scheduledOn ?? "") || a.jobNumber.localeCompare(b.jobNumber));
    const recordedBoundary = (value: string | null) => {
      try {
        return value ? boundary(value) : null;
      } catch {
        return null;
      }
    };
    const cutoverRows=await Promise.all(jobs.map(async job=>[job.id,await jobMigrationCutover(db,job)] as const));
    const cutoverByJob=new Map(cutoverRows);
    const revenueFor=(job:typeof jobs[number])=>{const cutover=cutoverByJob.get(job.id);return cutover?(cutover.forecastReportsEligible?cutover.financial.fullJobRevenueCents!/100:null):job.estRevenue;};
    const sold = jobs.filter((j) =>
      withinPeriod(recordedBoundary(eventDate(j, "sold")), from, to),
    );
    const completedRecords = jobs
      .filter((job) => ["Completed", "Invoiced"].includes(job.status))
      .map((job) => ({
        ...job,
        recordedCompletion: eventDate(job, "completed"),
      }));
    const completed = completedRecords.filter(
      (job): job is typeof job & { recordedCompletion: string } =>
        !!job.recordedCompletion &&
        withinPeriod(recordedBoundary(job.recordedCompletion), from, to),
    );
    const billed = invoices.filter(
      (i) =>
        !["Draft", "Voided"].includes(i.status) &&
        withinPeriod(recordedBoundary(i.issueDate), from, to),
    );
    const selectedBookings = bookings.filter(
      (b) =>
        b.status === "Confirmed" &&
        Date.parse(b.endAt) > Date.parse(from) &&
        Date.parse(b.startAt) < Date.parse(to),
    );
    let capacity = 0;
    const capacityKnown =
      crews.some((c) => c.active) &&
      crews
        .filter((c) => c.active)
        .every((c) => c.size && c.dailyCapacityHours && c.workingDays.length);
    for (const crew of crews.filter(
      (c) => c.active && c.size && c.dailyCapacityHours,
    )) {
      const dates = new Set<string>();
      for (
        let cursor = Date.parse(from) + 12 * 3600000;
        cursor < Date.parse(to);
        cursor += 86400000
      ) {
        const date = new Intl.DateTimeFormat("en-CA", {
          timeZone: crew.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(cursor));
        if (dates.has(date)) continue;
        dates.add(date);
        const day = new Intl.DateTimeFormat("en-US", {
          timeZone: crew.timezone,
          weekday: "short",
        }).format(new Date(cursor));
        if (
          crew.workingDays.includes(
            ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day),
          ) &&
          !crew.unavailableDates.includes(date)
        )
          capacity += crew.size! * crew.dailyCapacityHours!;
      }
    }
    const plannedHours = selectedBookings.reduce(
      (sum, b) => sum + b.plannedLaborHours,
      0,
    );
    const periodLabor = labor.filter((l) =>
      withinPeriod(recordedBoundary(l.date), from, to),
    );
    const actualHours = periodLabor
      .filter((l) => l.crewId)
      .reduce((sum, l) => sum + l.hours, 0);
    const materialUsageReport = await reportMaterialUsage(completed);
    const aging = invoiceAging(invoices, businessToday);
    const { records: completionRecords, ...completionSummary } = completionTimeliness(completed);
    res.json({
      from,
      to,
      timezone: "America/New_York",
      soldRevenue: sold.reduce((sum, j) => sum + (revenueFor(j)??0), 0),
      jobsSold: sold.length,
      completedRevenue: completed.reduce((sum, j) => sum + (revenueFor(j)??0), 0),
      migrationCutoverExclusions:{unknownSoldFinancials:sold.filter(job=>revenueFor(job)===null).length,unknownCompletedFinancials:completed.filter(job=>revenueFor(job)===null).length,unknownFullJobActuals:cutoverRows.filter(([,state])=>!!state).length,remainingBillingScopeExcludedFromFullJobRevenue:true},
      invoicedRevenue: billed.reduce((sum, i) => sum + i.total, 0),
      outstanding: invoices
        .filter((i) => ["Sent", "Partial", "Overdue"].includes(i.status))
        .reduce((sum, i) => sum + Math.max(0, i.balanceAmount), 0),
      asOfDate: businessToday,
      invoiceAging: aging.buckets,
      inventoryActivity: inventoryActivity(movements),
      completionTimeliness: completionSummary,
      stockAudit: stockAuditSummary(audits, postedCounts),
      materialUsageReport,
      installationReadiness: {
        through: shiftReportDate(installationUntil, -1),
        ready: installations.filter(({ status }) => status === "ready").length,
        materialsNeedAttention: installations.filter(({ status }) => status === "materialsNeedAttention").length,
        needsCrew: needsCrewJobIds.length,
      },
      sourceRecords: {
        invoices: aging.records.map(({ invoice, ...detail }) => ({
          invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, customerName: invoice.customerName, ...detail,
        })).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.invoiceNumber.localeCompare(b.invoiceNumber)),
        completions: completionRecords.map(({ job, ...detail }) => ({ ...jobSource(job), ...detail }))
          .sort((a, b) => b.completedOn.localeCompare(a.completedOn) || a.jobNumber.localeCompare(b.jobNumber)),
        installations,
        postedCounts,
      },
      capacityHours: capacityKnown ? capacity : null,
      plannedLaborHours: plannedHours,
      actualLaborHours: actualHours,
      scheduledUtilization:
        capacityKnown && capacity > 0 ? (plannedHours / capacity) * 100 : null,
      actualUtilization:
        capacityKnown &&
        capacity > 0 &&
        periodLabor.length > 0 &&
        periodLabor.every((l) => l.crewId)
          ? (actualHours / capacity) * 100
          : null,
      callbacksOpened: callbacks.filter((c) =>
        withinPeriod(c.createdAt, from, to),
      ).length,
      callbacksOpen: callbacks.filter((c) => c.status === "Open").length,
      missingSoldDates: jobs.filter(
        (j) =>
          [
            "Approved",
            "Material Ordered",
            "Material Received",
            "Scheduled",
            "In Progress",
            "Final Walkthrough",
            "Completed",
            "Invoiced",
          ].includes(j.status) && !eventDate(j, "sold"),
      ).length,
      missingCompletionDates: completedRecords.filter(
        (job) => !recordedBoundary(job.recordedCompletion),
      ).length,
      unassignedLaborEntries: periodLabor.filter((l) => !l.crewId).length,
      sourceJobIds: sold.map((j) => j.id),
      definition:
        "Sales use recorded approval dates; completed revenue uses recorded completion dates. Utilization uses person-hours. Missing historical dates and crew capacity are excluded, never inferred from record edits.",
    });
  }),
);
export default router;
