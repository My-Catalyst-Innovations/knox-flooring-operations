import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  jobsTable,
  usersTable,
  tasksTable,
  crewBookingsTable,
} from "@workspace/db";
import { domainRoute, parse } from "../lib/domain-http";
import { assertRevision, DomainError } from "../lib/operations-rules";

const router = Router();
function officeAssignment(req: Request, res: Response, next: NextFunction) {
  if (
    !req.auth ||
    req.auth.previewRole ||
    !["owner", "operations"].includes(req.auth.role)
  ) {
    res.status(403).json({
      error:
        "Exit role preview and use an owner or operations account to assign staff.",
    });
    return;
  }
  res.set("Cache-Control", "no-store");
  next();
}
const activeStaff = and(
  eq(usersTable.active, true),
  inArray(usersTable.role, ["owner", "sales", "operations", "installer"]),
  sql`${usersTable.passwordHash} NOT LIKE '!%'`,
);
router.get(
  "/tasks/assignees",
  officeAssignment,
  domainRoute(async (req, res) => {
    parse(z.object({}).strict(), req.query);
    res.json(
      await db
        .select({
          id: usersTable.id,
          name: usersTable.name,
          role: usersTable.role,
        })
        .from(usersTable)
        .where(activeStaff)
        .orderBy(asc(usersTable.name), asc(usersTable.id)),
    );
  }),
);
router.get(
  "/tasks/:id/assignment",
  officeAssignment,
  domainRoute(async (req, res) => {
    parse(z.object({}).strict(), req.query);
    const [task] = await db
      .select({
        taskId: tasksTable.id,
        jobId: tasksTable.relatedJobId,
        bookingId: tasksTable.bookingId,
        assigneeId: tasksTable.assigneeId,
        updatedAt: tasksTable.updatedAt,
        bookingRevision: crewBookingsTable.revision,
      })
      .from(tasksTable)
      .innerJoin(
        crewBookingsTable,
        and(
          eq(crewBookingsTable.id, tasksTable.bookingId),
          eq(crewBookingsTable.taskId, tasksTable.id),
          eq(crewBookingsTable.jobId, tasksTable.relatedJobId),
        ),
      )
      .innerJoin(jobsTable, eq(jobsTable.id, tasksTable.relatedJobId))
      .where(
        and(
          eq(tasksTable.id, String(req.params.id)),
          eq(crewBookingsTable.status, "Confirmed"),
          inArray(tasksTable.status, ["Open", "Done"]),
        ),
      );
    if (!task)
      throw new DomainError(404, "Active linked installation task not found.");
    res.json(task);
  }),
);
router.patch(
  "/tasks/:id/assignment",
  officeAssignment,
  domainRoute(async (req, res) => {
    parse(z.object({}).strict(), req.query);
    const data = parse(
      z
        .object({
          assigneeId: z.string().min(1).max(200).nullable(),
          updatedAt: z.string().min(1).max(100),
          bookingRevision: z.number().int().positive(),
        })
        .strict(),
      req.body,
    );
    const result = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({
          jobId: tasksTable.relatedJobId,
          bookingId: tasksTable.bookingId,
          crewId: crewBookingsTable.crewId,
        })
        .from(tasksTable)
        .innerJoin(
          crewBookingsTable,
          and(
            eq(crewBookingsTable.id, tasksTable.bookingId),
            eq(crewBookingsTable.taskId, tasksTable.id),
            eq(crewBookingsTable.jobId, tasksTable.relatedJobId),
          ),
        )
        .where(eq(tasksTable.id, String(req.params.id)));
      if (!before?.jobId || !before.bookingId)
        throw new DomainError(
          404,
          "Active linked installation task not found.",
        );
      // Use the schedule's crew lock, then recheck both immutable linkage sides.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"crew:" + before.crewId}))`,
      );
      const [job] = await tx
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(eq(jobsTable.id, before.jobId))
        .for("key share");
      const [booking] = await tx
        .select()
        .from(crewBookingsTable)
        .where(
          and(
            eq(crewBookingsTable.id, before.bookingId),
            eq(crewBookingsTable.taskId, String(req.params.id)),
            eq(crewBookingsTable.jobId, before.jobId),
            eq(crewBookingsTable.crewId, before.crewId),
            eq(crewBookingsTable.status, "Confirmed"),
          ),
        )
        .for("share");
      const [task] = await tx
        .select()
        .from(tasksTable)
        .where(
          and(
            eq(tasksTable.id, String(req.params.id)),
            eq(tasksTable.bookingId, before.bookingId),
            eq(tasksTable.relatedJobId, before.jobId),
            inArray(tasksTable.status, ["Open", "Done"]),
          ),
        )
        .for("update");
      if (!job || !booking || !task)
        throw new DomainError(
          404,
          "Active linked installation task not found.",
        );
      assertRevision(booking.revision, data.bookingRevision);
      if (task.updatedAt !== data.updatedAt)
        throw new DomainError(
          409,
          "This task changed. Refresh its assignment before saving.",
        );
      const previousTimestamp = Date.parse(task.updatedAt);
      if (!Number.isFinite(previousTimestamp))
        throw new DomainError(
          409,
          "The saved task timestamp needs office review before assignment.",
        );
      if (data.assigneeId !== null) {
        const [staff] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(and(eq(usersTable.id, data.assigneeId), activeStaff))
          .for("share");
        if (!staff)
          throw new DomainError(
            400,
            "Choose an active staff member from this company.",
          );
      }
      const [saved] = await tx
        .update(tasksTable)
        .set({
          assigneeId: data.assigneeId,
          updatedAt: new Date(
            Math.max(Date.now(), previousTimestamp + 1),
          ).toISOString(),
        })
        .where(eq(tasksTable.id, task.id))
        .returning({
          taskId: tasksTable.id,
          jobId: tasksTable.relatedJobId,
          bookingId: tasksTable.bookingId,
          assigneeId: tasksTable.assigneeId,
          updatedAt: tasksTable.updatedAt,
        });
      // Assignment does not change dates, capacity, crew, stage, tokens or providers.
      return { ...saved, bookingRevision: booking.revision };
    });
    res.json(result);
  }),
);
export default router;
