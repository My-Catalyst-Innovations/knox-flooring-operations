import {
  and,
  asc,
  eq,
  inArray,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  db,
  jobsTable,
  tasksTable,
  crewBookingsTable,
  type AppRole,
} from "@workspace/db";
import type { Transaction } from "./estimate-service";
import { DomainError } from "./operations-rules";

export type InstallerActor = { userId: string; role: AppRole };

/** Explicit personal task assignment only. A crew name is never membership. */
export function installerAssignment(
  actor: InstallerActor,
  jobId?: string | SQLWrapper,
): SQL | undefined {
  return and(
    eq(tasksTable.assigneeId, actor.userId),
    jobId === undefined
      ? sql`${tasksTable.relatedJobId} IS NOT NULL`
      : eq(tasksTable.relatedJobId, jobId),
    inArray(tasksTable.status, ["Open", "Done"]),
    sql`(${tasksTable.bookingId} IS NULL OR EXISTS (
      SELECT 1 FROM ${crewBookingsTable}
      WHERE ${crewBookingsTable.id} = ${tasksTable.bookingId}
        AND ${crewBookingsTable.taskId} = ${tasksTable.id}
        AND ${crewBookingsTable.jobId} = ${tasksTable.relatedJobId}
        AND ${crewBookingsTable.status} = 'Confirmed'
    ))`,
  );
}

export const installerJobAccess = (actor: InstallerActor) => sql`EXISTS (
  SELECT 1 FROM ${tasksTable} WHERE ${installerAssignment(actor, jobsTable.id)}
)`;

export const installerJobFields = {
  id: jobsTable.id,
  jobNumber: jobsTable.jobNumber,
  customerName: jobsTable.customerName,
  address: jobsTable.address,
  city: jobsTable.city,
  flooringType: jobsTable.flooringType,
  rooms: jobsTable.rooms,
  status: jobsTable.status,
  estStartDate: jobsTable.estStartDate,
  estCompletionDate: jobsTable.estCompletionDate,
};
export const installerTaskFields = {
  id: tasksTable.id,
  title: tasksTable.title,
  startAt: tasksTable.startAt,
  endAt: tasksTable.endAt,
  allDay: tasksTable.allDay,
  status: tasksTable.status,
  relatedJobId: tasksTable.relatedJobId,
  bookingId: tasksTable.bookingId,
};

/** Whitelist nested JSON too; unknown stored room properties are not an export. */
export function installerJobDto(
  job: Pick<typeof jobsTable.$inferSelect, keyof typeof installerJobFields>,
) {
  const rooms = Array.isArray(job.rooms)
    ? job.rooms.flatMap((room) => {
        if (
          !room ||
          typeof room !== "object" ||
          Array.isArray(room) ||
          typeof room.id !== "string" ||
          typeof room.name !== "string" ||
          !Number.isFinite(room.length) ||
          !Number.isFinite(room.width)
        )
          return [];
        return [
          {
            id: room.id,
            name: room.name,
            length: room.length,
            width: room.width,
          },
        ];
      })
    : [];
  return {
    id: job.id,
    jobNumber: job.jobNumber,
    customerName: job.customerName,
    address: job.address,
    city: job.city,
    flooringType: job.flooringType,
    // Conversion summaries can include quote totals. Do not expose raw scope
    // text or try to remove prices with a regex; use only operational structure.
    scopeOfWork: `Flooring: ${job.flooringType}. ${rooms.length} recorded room(s). Confirm installation instructions with the office.`,
    status: job.status,
    estStartDate: job.estStartDate,
    estCompletionDate: job.estCompletionDate,
    rooms,
  };
}

/**
 * All mutation callers hold job -> grant task -> booking locks through their
 * write. Reassignment/cancellation must wait; a grant removed before the locks
 * are acquired is rechecked and rejected. Effective role includes role preview.
 */
export async function assertInstallerJobAccess(
  tx: Transaction,
  actor: InstallerActor,
  jobId: string,
  lock = false,
) {
  if (actor.role !== "installer")
    throw new DomainError(403, "Installer access requires the installer role.");
  const query = tx
    .select(installerJobFields)
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), installerJobAccess(actor)));
  const [job] = await (lock ? query.for("key share") : query);
  if (!job) throw new DomainError(404, "Assigned job not found.");
  if (lock) {
    const [task] = await tx
      .select(installerTaskFields)
      .from(tasksTable)
      .where(installerAssignment(actor, jobId))
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
  return installerJobDto(job);
}

export const readInstallerJob = <T>(
  actor: InstallerActor,
  jobId: string,
  fn: (tx: Transaction) => Promise<T>,
) =>
  db.transaction(
    async (tx) => {
      await assertInstallerJobAccess(tx, actor, jobId);
      return fn(tx);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

export const writeInstallerJob = <T>(
  actor: InstallerActor,
  jobId: string,
  fn: (tx: Transaction) => Promise<T>,
) =>
  db.transaction(async (tx) => {
    await assertInstallerJobAccess(tx, actor, jobId, true);
    return fn(tx);
  });

/** Only the booking attached to an explicit own task grants crew/time access. */
export function installerBookingAccess(actor: InstallerActor) {
  return sql`EXISTS (SELECT 1 FROM ${tasksTable} WHERE ${installerAssignment(actor, crewBookingsTable.jobId)} AND ${tasksTable.bookingId} = ${crewBookingsTable.id} AND ${tasksTable.id} = ${crewBookingsTable.taskId})`;
}

export async function lockInstallerBooking(
  tx: Transaction,
  actor: InstallerActor,
  jobId: string,
  bookingId: string,
  crewId?: string,
) {
  const [task] = await tx
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(
      and(
        installerAssignment(actor, jobId),
        eq(tasksTable.bookingId, bookingId),
      ),
    )
    .orderBy(asc(tasksTable.id))
    .limit(1)
    .for("share");
  if (!task)
    throw new DomainError(
      403,
      "Choose the confirmed booking explicitly assigned to your account.",
    );
  const [booking] = await tx
    .select({ id: crewBookingsTable.id, crewId: crewBookingsTable.crewId })
    .from(crewBookingsTable)
    .where(
      and(
        eq(crewBookingsTable.id, bookingId),
        eq(crewBookingsTable.taskId, task.id),
        eq(crewBookingsTable.jobId, jobId),
        crewId ? eq(crewBookingsTable.crewId, crewId) : undefined,
        eq(crewBookingsTable.status, "Confirmed"),
      ),
    )
    .for("share");
  if (!booking)
    throw new DomainError(
      403,
      "Choose the confirmed booking explicitly assigned to your account.",
    );
  return booking;
}
