import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  jobsTable,
  tasksTable,
  crewBookingsTable,
  crewsTable,
  jobMaterialsTable,
  jobUpdatesTable,
  jobPhotosTable,
  laborEntriesTable,
  settingsTable,
  purchaseOrdersTable,
  purchaseOrderLinesTable,
  purchaseReceiptsTable,
  purchaseReceiptLinesTable,
  inventoryMovementsTable,
  inventoryReservationsTable,
  warehouseBinsTable,
  warehousesTable,
  usersTable,
  type AppRole,
} from "@workspace/db";
import type { Transaction } from "./estimate-service";
import { DomainError } from "./operations-rules";
import { installationGuide, warehouseGuide } from "./work-guide-evidence";

export type GuideActor = { userId: string; role: AppRole };
const jobFields = {
  id: jobsTable.id,
  jobNumber: jobsTable.jobNumber,
  customerName: jobsTable.customerName,
  address: jobsTable.address,
  city: jobsTable.city,
  flooringType: jobsTable.flooringType,
  scopeOfWork: jobsTable.scopeOfWork,
  rooms: jobsTable.rooms,
  status: jobsTable.status,
};
const taskFields = {
  id: tasksTable.id,
  title: tasksTable.title,
  startAt: tasksTable.startAt,
  endAt: tasksTable.endAt,
  status: tasksTable.status,
  bookingId: tasksTable.bookingId,
};
const nonCancelledAssignment = (
  actor: GuideActor,
  jobId: string | typeof jobsTable.id,
) =>
  and(
    eq(tasksTable.assigneeId, actor.userId),
    eq(tasksTable.relatedJobId, jobId),
    inArray(tasksTable.status, ["Open", "Done"]),
    sql`(${tasksTable.bookingId} IS NULL OR EXISTS (SELECT 1 FROM ${crewBookingsTable} WHERE ${crewBookingsTable.id} = ${tasksTable.bookingId} AND ${crewBookingsTable.taskId} = ${tasksTable.id} AND ${crewBookingsTable.jobId} = ${tasksTable.relatedJobId} AND ${crewBookingsTable.status} = 'Confirmed'))`,
  );
const accessibleJob = (actor: GuideActor) =>
  actor.role === "installer"
    ? sql`EXISTS (SELECT 1 FROM ${tasksTable} WHERE ${nonCancelledAssignment(actor, jobsTable.id)})`
    : undefined;

/** No crew-name/email/actual-owner inference. Uses the request's tenant DB. */
export async function assertGuideJobAccess(
  tx: Transaction,
  actor: GuideActor,
  jobId: string,
  lock = false,
) {
  if (!["owner", "sales", "operations", "installer"].includes(actor.role))
    throw new DomainError(403, "Work guides are unavailable for this role.");
  const query = tx
    .select(jobFields)
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), accessibleJob(actor)));
  const [job] = await (lock ? query.for("key share") : query);
  if (!job) throw new DomainError(404, "Assigned job not found.");
  if (lock && actor.role === "installer") {
    const [task] = await tx
      .select(taskFields)
      .from(tasksTable)
      .where(nonCancelledAssignment(actor, jobId))
      .orderBy(asc(tasksTable.id))
      .limit(1)
      .for("share");
    if (!task) throw new DomainError(404, "Assigned job not found.");
    if (task.bookingId) {
      const [booking] = await tx
        .select({ id: crewBookingsTable.id })
        .from(crewBookingsTable)
        .where(
          and(
            eq(crewBookingsTable.id, task.bookingId),
            eq(crewBookingsTable.taskId, task.id),
            eq(crewBookingsTable.jobId, jobId),
            eq(crewBookingsTable.status, "Confirmed"),
          ),
        )
        .for("share");
      if (!booking) throw new DomainError(404, "Assigned job not found.");
    }
  }
  return job;
}

export async function listGuideJobs(actor: GuideActor, search: string) {
  const term = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db
    .select({
      id: jobsTable.id,
      jobNumber: jobsTable.jobNumber,
      customerName: jobsTable.customerName,
      status: jobsTable.status,
    })
    .from(jobsTable)
    .where(
      and(
        accessibleJob(actor),
        search
          ? or(
              ilike(jobsTable.jobNumber, term),
              ilike(jobsTable.customerName, term),
            )
          : undefined,
      ),
    )
    .orderBy(desc(jobsTable.updatedAt), asc(jobsTable.id))
    .limit(101);
  return {
    jobs: rows.slice(0, 100),
    hasMore: rows.length > 100,
    assignmentRequired: actor.role === "installer",
  };
}
async function readWorkOrder(
  tx: Transaction,
  actor: GuideActor,
  jobId: string,
) {
  const job = await assertGuideJobAccess(tx, actor, jobId);
  const tasks =
    actor.role === "installer"
      ? await tx
          .select(taskFields)
          .from(tasksTable)
          .where(nonCancelledAssignment(actor, jobId))
          .orderBy(asc(tasksTable.startAt))
      : [];
  const bookings = await tx
    .select({
      id: crewBookingsTable.id,
      taskId: crewBookingsTable.taskId,
      crewId: crewBookingsTable.crewId,
      crewName: crewsTable.name,
      startAt: crewBookingsTable.startAt,
      endAt: crewBookingsTable.endAt,
    })
    .from(crewBookingsTable)
    .innerJoin(crewsTable, eq(crewsTable.id, crewBookingsTable.crewId))
    .where(
      and(
        eq(crewBookingsTable.jobId, jobId),
        eq(crewBookingsTable.status, "Confirmed"),
        actor.role === "installer"
          ? inArray(
              crewBookingsTable.id,
              tasks.flatMap((task) => (task.bookingId ? [task.bookingId] : [])),
            )
          : undefined,
      ),
    )
    .orderBy(asc(crewBookingsTable.startAt));
  const materials = await tx
    .select({
      id: jobMaterialsTable.id,
      name: jobMaterialsTable.name,
      quantity: jobMaterialsTable.quantity,
      unit: jobMaterialsTable.unit,
    })
    .from(jobMaterialsTable)
    .where(eq(jobMaterialsTable.jobId, jobId));
  return { job, tasks, bookings, materials };
}
export const guideWorkOrder = (actor: GuideActor, jobId: string) =>
  db.transaction((tx) => readWorkOrder(tx, actor, jobId), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });

export async function readWorkGuide(
  actor: GuideActor,
  jobId: string,
  selectedOrderId?: string,
) {
  return db.transaction(
    async (tx) => {
      const workOrder = await readWorkOrder(tx, actor, jobId);
      const [job] = await tx
        .select({
          completedAt: jobsTable.completedAt,
          completionChecklist: jobsTable.completionChecklist,
        })
        .from(jobsTable)
        .where(eq(jobsTable.id, jobId));
      const [settings] = await tx
        .select({ policy: settingsTable.transitionPolicy })
        .from(settingsTable)
        .limit(1);
      const [updates, photos, labor] = await Promise.all([
        tx
          .select({
            id: jobUpdatesTable.id,
            authorName: jobUpdatesTable.authorName,
            message: jobUpdatesTable.message,
            createdAt: jobUpdatesTable.createdAt,
          })
          .from(jobUpdatesTable)
          .where(
            and(
              eq(jobUpdatesTable.jobId, jobId),
              eq(jobUpdatesTable.authorId, actor.userId),
            ),
          )
          .orderBy(desc(jobUpdatesTable.createdAt), desc(jobUpdatesTable.id))
          .limit(50),
        tx
          .select({ id: jobPhotosTable.id })
          .from(jobPhotosTable)
          .where(
            and(
              eq(jobPhotosTable.jobId, jobId),
              inArray(jobPhotosTable.stage, ["Final Walkthrough", "Completed"]),
            ),
          ),
        tx
          .select({ hours: laborEntriesTable.hours })
          .from(laborEntriesTable)
          .where(
            and(
              eq(laborEntriesTable.jobId, jobId),
              inArray(
                laborEntriesTable.bookingId,
                workOrder.bookings.map((booking) => booking.id),
              ),
              sql`${laborEntriesTable.crewId} = (SELECT ${crewBookingsTable.crewId} FROM ${crewBookingsTable} WHERE ${crewBookingsTable.id} = ${laborEntriesTable.bookingId} AND ${crewBookingsTable.jobId} = ${laborEntriesTable.jobId} AND ${crewBookingsTable.status} = 'Confirmed')`,
            ),
          ),
      ]);
      const requiredChecks = [
        ...new Set(settings?.policy?.requiredCompletionChecks ?? []),
      ].filter((key) => typeof key === "string" && key.trim());
      const installer = actor.role === "installer";
      const installation = installationGuide({
        jobId,
        installer,
        assignedTasks: workOrder.tasks.length,
        confirmedBookings: workOrder.bookings.length,
        ownUpdates: updates.length,
        finalPhotos: photos.length,
        recordedHours: labor
          .filter((entry) => Number.isFinite(entry.hours) && entry.hours > 0)
          .reduce((sum, entry) => sum + entry.hours, 0),
        status: workOrder.job.status,
        completedAt: job.completedAt,
        completionChecklist: job.completionChecklist,
        requiredChecks,
      });
      if (installer) {
        if (selectedOrderId)
          throw new DomainError(
            403,
            "Warehouse guides are available to owner and operations roles.",
          );
        return {
          ...workOrder,
          installation,
          warehouse: null,
          orders: [],
          selectedOrderId: null,
          ownUpdates: updates,
          checkedAt: new Date().toISOString(),
        };
      }
      const orders = await tx
        .select({
          id: purchaseOrdersTable.id,
          number: purchaseOrdersTable.number,
          supplier: purchaseOrdersTable.supplier,
          status: purchaseOrdersTable.status,
          warehouseId: purchaseOrdersTable.warehouseId,
          warehouseName: warehousesTable.name,
        })
        .from(purchaseOrdersTable)
        .innerJoin(
          warehousesTable,
          eq(warehousesTable.id, purchaseOrdersTable.warehouseId),
        )
        .where(eq(purchaseOrdersTable.jobId, jobId))
        .orderBy(desc(purchaseOrdersTable.number));
      const order = selectedOrderId
        ? orders.find((item) => item.id === selectedOrderId)
        : null;
      if (selectedOrderId && !order)
        throw new DomainError(404, "Linked purchase order not found.");
      const lines = order
        ? await tx
            .select({
              id: purchaseOrderLinesTable.id,
              productId: purchaseOrderLinesTable.productId,
              quantity: purchaseOrderLinesTable.quantity,
            })
            .from(purchaseOrderLinesTable)
            .where(eq(purchaseOrderLinesTable.orderId, order.id))
        : [];
      const receiptLines = order
        ? await tx
            .select({
              lineId: purchaseReceiptLinesTable.lineId,
              movementId: purchaseReceiptLinesTable.movementId,
              quantity: purchaseReceiptLinesTable.quantity,
            })
            .from(purchaseReceiptLinesTable)
            .innerJoin(
              purchaseReceiptsTable,
              eq(purchaseReceiptsTable.id, purchaseReceiptLinesTable.receiptId),
            )
            .innerJoin(
              purchaseOrderLinesTable,
              eq(purchaseOrderLinesTable.id, purchaseReceiptLinesTable.lineId),
            )
            .where(
              and(
                eq(purchaseReceiptsTable.orderId, order.id),
                eq(purchaseOrderLinesTable.orderId, order.id),
              ),
            )
        : [];
      const productIds = lines.map((line) => line.productId);
      const [movements, bins, reservations] =
        order && productIds.length
          ? await Promise.all([
              tx
                .select({
                  id: inventoryMovementsTable.id,
                  productId: inventoryMovementsTable.productId,
                  jobId: inventoryMovementsTable.jobId,
                  warehouseId: inventoryMovementsTable.warehouseId,
                  binId: inventoryMovementsTable.binId,
                  kind: inventoryMovementsTable.kind,
                  quantity: inventoryMovementsTable.quantity,
                  returnOfMovementId:
                    inventoryMovementsTable.returnOfMovementId,
                })
                .from(inventoryMovementsTable)
                .where(
                  and(
                    inArray(inventoryMovementsTable.productId, productIds),
                    or(
                      and(
                        eq(
                          inventoryMovementsTable.warehouseId,
                          order.warehouseId,
                        ),
                        or(
                          inArray(
                            inventoryMovementsTable.id,
                            receiptLines.flatMap((line) =>
                              line.movementId ? [line.movementId] : [],
                            ),
                          ),
                          and(
                            eq(inventoryMovementsTable.jobId, jobId),
                            eq(inventoryMovementsTable.kind, "consume"),
                          ),
                        ),
                      ),
                      and(
                        eq(inventoryMovementsTable.jobId, jobId),
                        eq(inventoryMovementsTable.kind, "return"),
                      ),
                    ),
                  ),
                ),
              tx
                .select({
                  id: warehouseBinsTable.id,
                  warehouseId: warehouseBinsTable.warehouseId,
                })
                .from(warehouseBinsTable)
                .where(eq(warehouseBinsTable.warehouseId, order.warehouseId)),
              tx
                .select({
                  productId: inventoryReservationsTable.productId,
                  jobId: inventoryReservationsTable.jobId,
                  warehouseId: inventoryReservationsTable.warehouseId,
                  stagedBinId: inventoryReservationsTable.stagedBinId,
                  status: inventoryReservationsTable.status,
                  quantity: inventoryReservationsTable.quantity,
                })
                .from(inventoryReservationsTable)
                .where(
                  and(
                    eq(inventoryReservationsTable.jobId, jobId),
                    eq(
                      inventoryReservationsTable.warehouseId,
                      order.warehouseId,
                    ),
                  ),
                ),
            ])
          : [[], [], []];
      return {
        ...workOrder,
        installation,
        warehouse: warehouseGuide({
          jobId,
          order: order ?? null,
          lines,
          receiptLines,
          movements,
          bins,
          reservations,
        }),
        orders,
        selectedOrderId: order?.id ?? null,
        ownUpdates: updates,
        checkedAt: new Date().toISOString(),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function saveGuideUpdate(
  actor: GuideActor,
  jobId: string,
  data: { id: string; message: string },
) {
  return db.transaction(async (tx) => {
    await assertGuideJobAccess(tx, actor, jobId, true);
    const [author] = await tx
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, actor.userId));
    if (!author)
      throw new DomainError(403, "The author could not be verified.");
    const fields = {
      id: jobUpdatesTable.id,
      authorName: jobUpdatesTable.authorName,
      message: jobUpdatesTable.message,
      createdAt: jobUpdatesTable.createdAt,
    };
    const [created] = await tx
      .insert(jobUpdatesTable)
      .values({
        ...data,
        jobId,
        authorId: actor.userId,
        authorName: author.name,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning(fields);
    if (created) return { status: 201, update: created };
    const [existing] = await tx
      .select()
      .from(jobUpdatesTable)
      .where(eq(jobUpdatesTable.id, data.id));
    if (
      !existing ||
      existing.jobId !== jobId ||
      existing.authorId !== actor.userId ||
      existing.message !== data.message
    )
      throw new DomainError(
        409,
        "This update ID already belongs to a different entry.",
      );
    return {
      status: 200,
      update: {
        id: existing.id,
        authorName: existing.authorName,
        message: existing.message,
        createdAt: existing.createdAt,
      },
    };
  });
}
