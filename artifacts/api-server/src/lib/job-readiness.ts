import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  jobsTable,
  settingsTable,
  crewBookingsTable,
  materialsTable,
  jobMaterialsTable,
  productsTable,
  inventoryReservationsTable,
  inventoryMovementsTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  purchaseReceiptLinesTable,
  auditEventsTable,
  type JobInsert,
} from "@workspace/db";
import type { Transaction } from "./estimate-service";
import { assertRevision, DomainError } from "./operations-rules";

export const JOB_STAGES = [
  "New Lead",
  "Estimate Scheduled",
  "Estimate Completed",
  "Proposal Sent",
  "Approved",
  "Material Ordered",
  "Material Received",
  "Scheduled",
  "In Progress",
  "Final Walkthrough",
  "Completed",
  "Invoiced",
];

async function stockReadinessMessages(tx: Transaction, jobIds: string[]) {
  const requirements = await tx
    .select()
    .from(jobMaterialsTable)
    .where(inArray(jobMaterialsTable.jobId, jobIds));
  const productIds = [
    ...new Set(
      requirements.flatMap((item) => (item.productId ? [item.productId] : [])),
    ),
  ];
  if (!productIds.length)
    return new Map<
      string,
      Array<{ code: string; message: string; href: string }>
    >();
  const orders = purchaseOrdersTable;
  const orderLines = purchaseOrderLinesTable;
  const receiptLines = purchaseReceiptLinesTable;
  const [products, reservations, movements, deliveries] = await Promise.all([
    tx
      .select()
      .from(productsTable)
      .where(inArray(productsTable.id, productIds)),
    tx
      .select()
      .from(inventoryReservationsTable)
      .where(
        and(
          inArray(inventoryReservationsTable.productId, productIds),
          eq(inventoryReservationsTable.status, "Active"),
        ),
      ),
    tx
      .select()
      .from(inventoryMovementsTable)
      .where(
        and(
          inArray(inventoryMovementsTable.productId, productIds),
          inArray(inventoryMovementsTable.jobId, jobIds),
          inArray(inventoryMovementsTable.kind, ["consume", "return"]),
        ),
      ),
    tx
      .select({
        orderId: orders.id,
        jobId: orders.jobId,
        expectedOn: orders.expectedOn,
        productId: orderLines.productId,
        unit: orderLines.unit,
        ordered: orderLines.quantity,
        accepted: sql<string>`coalesce(sum(${receiptLines.quantity}), 0)`,
      })
      .from(orders)
      .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
      .leftJoin(receiptLines, eq(receiptLines.lineId, orderLines.id))
      .where(
        and(
          inArray(orders.jobId, jobIds),
          inArray(orders.status, ["Ordered", "Partially received"]),
          inArray(orderLines.productId, productIds),
        ),
      )
      .groupBy(orders.id, orderLines.id)
      .orderBy(asc(orders.expectedOn), asc(orders.number)),
  ]);
  return new Map(
    jobIds.map((jobId) => [
      jobId,
      products
        .filter((product) => product.inventoryType === "Inventory")
        .flatMap((product) => {
          const lines = requirements.filter(
            (item) => item.productId === product.id && item.jobId === jobId,
          );
          if (!lines.length) return [];
          if (
            lines.some(
              (item) =>
                item.unit.trim().toLowerCase() !==
                product.unit.trim().toLowerCase(),
            )
          ) {
            return [
              {
                code: `material_unit_${product.id}`,
                message: `${product.name}: confirm the job and warehouse units before comparing stock.`,
                href: `/jobs/${jobId}`,
              },
            ];
          }
          const required = lines.reduce((sum, item) => sum + item.quantity, 0);
          const reservedForOtherJobs = reservations
            .filter(
              (item) => item.productId === product.id && item.jobId !== jobId,
            )
            .reduce((sum, item) => sum + item.quantity, 0);
          const issuedToJob = movements
            .filter(
              (item) => item.productId === product.id && item.jobId === jobId,
            )
            .reduce((sum, item) => sum - item.quantity, 0);
          const usable =
            Math.max(0, product.quantityOnHand - reservedForOtherJobs) +
            Math.max(0, issuedToJob);
          if (required - usable <= 0.000001) return [];
          const format = (amount: number) =>
            amount.toLocaleString("en-US", { maximumFractionDigits: 3 });
          const delivery = deliveries.find(
            (line) =>
              line.jobId === jobId &&
              line.productId === product.id &&
              line.unit === product.unit &&
              Number(line.accepted) < Number(line.ordered),
          );
          const available = `${product.name}: ${format(usable)} of ${format(required)} ${product.unit} available or issued to this job.`;
          const receipt = delivery
            ? ` ${format(Number(delivery.accepted))} of ${format(Number(delivery.ordered))} ${product.unit} received on the linked order. ${format(Number(delivery.ordered) - Number(delivery.accepted))} outstanding${delivery.expectedOn ? `, expected ${delivery.expectedOn}` : ", delivery date unconfirmed"}.`
            : "";
          return [
            {
              code: `material_shortage_${product.id}`,
              message: available + receipt,
              href: `/jobs/${jobId}`,
            },
          ];
        }),
    ]),
  );
}

export async function installationMaterialMessages(
  tx: Transaction,
  jobIds: string[],
) {
  if (!jobIds.length)
    return new Map<
      string,
      Array<{ code: string; message: string; href: string }>
    >();
  const [receipts, stockIssues] = await Promise.all([
    tx
      .select()
      .from(materialsTable)
      .where(inArray(materialsTable.jobId, jobIds)),
    stockReadinessMessages(tx, jobIds),
  ]);
  return new Map(
    jobIds.map((jobId) => {
      const records = receipts.filter((receipt) => receipt.jobId === jobId);
      const ready =
        records.length > 0 &&
        records.every(
          (receipt) =>
            receipt.received &&
            !receipt.damaged &&
            !receipt.missingItems.trim(),
        );
      const issues = stockIssues.get(jobId) ?? [];
      return [
        jobId,
        ready
          ? issues
          : [
              {
                code: "materials_unconfirmed",
                message:
                  "Material receipt and condition have not been confirmed.",
                href: "/materials",
              },
              ...issues,
            ],
      ];
    }),
  );
}
export async function jobReadiness(
  tx: Transaction,
  jobId: string,
  targetStage: string,
  pending: Partial<JobInsert> = {},
) {
  const [current] = await tx
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!current) throw new DomainError(404, "Job not found");
  if (!JOB_STAGES.includes(targetStage))
    throw new DomainError(400, "Choose a valid job stage.");
  const job = { ...current, ...pending };
  const [settings] = await tx.select().from(settingsTable).limit(1);
  const policy = settings?.transitionPolicy;
  const blockers: Array<{ code: string; message: string; href: string }> = [];
  const warnings: typeof blockers = [];
  if (["Scheduled", "In Progress"].includes(targetStage)) {
    const bookings = await tx
      .select()
      .from(crewBookingsTable)
      .where(eq(crewBookingsTable.jobId, jobId));
    if (!bookings.some((b) => b.status === "Confirmed"))
      blockers.push({
        code: "booking_required",
        message: "Confirm a dated crew booking before scheduling installation.",
        href: "/schedule",
      });
    const materialMessages = await installationMaterialMessages(tx, [jobId]);
    (policy?.requireReceivedMaterials ? blockers : warnings).push(
      ...(materialMessages.get(jobId) ?? []),
    );
  }
  if (["Completed", "Invoiced"].includes(targetStage)) {
    const required = policy?.requiredCompletionChecks ?? [];
    for (const check of required)
      if (!job.completionChecklist?.[check])
        blockers.push({
          code: "closeout_" + check,
          message: `Complete the ${check.replace(/([A-Z])/g, " $1").toLowerCase()} check.`,
          href: `/jobs/${jobId}`,
        });
    if (!required.length)
      warnings.push({
        code: "closeout_policy_unconfigured",
        message:
          "Required closeout checks have not been configured by the owner.",
        href: "/settings",
      });
  }
  return {
    jobId,
    targetStage,
    revision: current.revision,
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}
export async function updateJobWithReadiness(
  tx: Transaction,
  jobId: string,
  updates: Partial<JobInsert>,
  actor: { userId: string; actualRole: string; previewRole?: string | null },
  expected?: number,
  overrideReason?: string,
) {
  const [current] = await tx
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .for("update");
  if (!current) throw new DomainError(404, "Job not found");
  assertRevision(current.revision, expected);
  await assertCutoverJobEdit(tx, current, updates);
  const now = new Date().toISOString();
  const statusChanged =
    updates.status !== undefined && updates.status !== current.status;
  if (statusChanged) {
    await assertCutoverOperationalTransition(tx, current, updates.status!);
    const readiness = await jobReadiness(tx, jobId, updates.status!, updates);
    if (
      readiness.blockers.length &&
      !(
        actor.actualRole === "owner" &&
        !actor.previewRole &&
        overrideReason?.trim()
      )
    )
      throw new DomainError(
        409,
        "Complete the readiness checks before changing this stage.",
        readiness,
      );
    if (overrideReason && (actor.actualRole !== "owner" || actor.previewRole))
      throw new DomainError(
        403,
        "Only the owner outside role preview can override readiness.",
      );
    updates.stageHistory = [
      ...current.stageHistory,
      { stage: updates.status!, at: now },
    ];
    if (updates.status === "Approved" && !current.soldAt) {
      updates.soldAt = now;
      updates.eventDateSource = "stage_transition";
    }
    if (updates.status === "Completed") updates.completedAt = now;
    if (
      ["Completed", "Invoiced"].includes(current.status) &&
      !["Completed", "Invoiced"].includes(updates.status!)
    )
      updates.completedAt = null;
    await tx
      .insert(auditEventsTable)
      .values({
        id: randomUUID(),
        actorUserId: actor.userId,
        action: overrideReason
          ? "job.transition_overridden"
          : "job.transitioned",
        entityType: "job",
        entityId: jobId,
        details: {
          from: current.status,
          to: updates.status,
          overrideReason: overrideReason ?? null,
          blockers: readiness.blockers,
          warnings: readiness.warnings,
        },
        createdAt: now,
      });
  }
  const [job] = await tx
    .update(jobsTable)
    .set({ ...updates, revision: current.revision + 1, updatedAt: now })
    .where(eq(jobsTable.id, jobId))
    .returning();
  return job;
}
import { assertCutoverJobEdit, assertCutoverOperationalTransition } from "./job-cutover";
