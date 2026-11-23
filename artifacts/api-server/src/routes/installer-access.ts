import { Router } from "express";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  jobsTable,
  tasksTable,
  crewBookingsTable,
  crewsTable,
  jobUpdatesTable,
  usersTable,
  jobMaterialsTable,
  jobPhotosTable,
  laborEntriesTable,
  materialUsageTable,
} from "@workspace/db";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { assertOwnedFile, storedFilePath } from "../lib/file-store";
import {
  assertInstallerJobAccess,
  installerAssignment,
  installerBookingAccess,
  installerJobAccess,
  installerJobDto,
  installerJobFields,
  installerTaskFields,
  lockInstallerBooking,
  readInstallerJob,
  writeInstallerJob,
} from "../lib/installer-access";
import { JOB_STAGES } from "../lib/job-readiness";

const boundary = Router();
const router = Router();
const updates = {
  id: jobUpdatesTable.id,
  authorName: jobUpdatesTable.authorName,
  message: jobUpdatesTable.message,
  createdAt: jobUpdatesTable.createdAt,
};
const photos = {
  id: jobPhotosTable.id,
  jobId: jobPhotosTable.jobId,
  stage: jobPhotosTable.stage,
  objectPath: jobPhotosTable.objectPath,
  caption: jobPhotosTable.caption,
  createdAt: jobPhotosTable.createdAt,
};
const labor = {
  id: laborEntriesTable.id,
  jobId: laborEntriesTable.jobId,
  date: laborEntriesTable.date,
  crew: laborEntriesTable.crew,
  crewId: laborEntriesTable.crewId,
  bookingId: laborEntriesTable.bookingId,
  hours: laborEntriesTable.hours,
  createdAt: laborEntriesTable.createdAt,
};
const materials = {
  id: jobMaterialsTable.id,
  name: jobMaterialsTable.name,
  quantity: jobMaterialsTable.quantity,
  unit: jobMaterialsTable.unit,
};
const noQuery = (query: unknown) => parse(z.object({}).strict(), query);
const jobId = (req: { params: Record<string, unknown> }) =>
  String(req.params.id);

// Office roles keep their existing handlers. Owner preview is deliberately not
// an escape hatch: requireAuth sets the effective role before this boundary.
boundary.use((req, res, next) =>
  req.auth?.role === "installer" ? router(req, res, next) : next(),
);
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get(
  "/jobs",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      (
        await db
          .select(installerJobFields)
          .from(jobsTable)
          .where(installerJobAccess(req.auth!))
          .orderBy(asc(jobsTable.id))
      ).map(installerJobDto),
    );
  }),
);
router.get(
  "/jobs/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await db.transaction(
        (tx) => assertInstallerJobAccess(tx, req.auth!, jobId(req)),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
    );
  }),
);
router.get(
  "/tasks",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await db
        .select(installerTaskFields)
        .from(tasksTable)
        .where(installerAssignment(req.auth!))
        .orderBy(asc(tasksTable.id)),
    );
  }),
);
router.patch(
  "/tasks/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const data = parse(
      z.object({ status: z.enum(["Open", "Done"]) }).strict(),
      req.body,
    );
    const saved = await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ jobId: tasksTable.relatedJobId })
        .from(tasksTable)
        .where(
          and(eq(tasksTable.id, jobId(req)), installerAssignment(req.auth!)),
        );
      if (!candidate?.jobId)
        throw new DomainError(404, "Assigned task not found.");
      await assertInstallerJobAccess(tx, req.auth!, candidate.jobId, true);
      const [current] = await tx
        .select(installerTaskFields)
        .from(tasksTable)
        .where(
          and(
            eq(tasksTable.id, jobId(req)),
            installerAssignment(req.auth!, candidate.jobId),
          ),
        )
        .for("update");
      if (!current) throw new DomainError(404, "Assigned task not found.");
      if (current.bookingId)
        await lockInstallerBooking(
          tx,
          req.auth!,
          candidate.jobId,
          current.bookingId,
        );
      // Status is local task progress only. No schedule, job stage or provider sync.
      const [task] = await tx
        .update(tasksTable)
        .set({ status: data.status, updatedAt: new Date().toISOString() })
        .where(eq(tasksTable.id, current.id))
        .returning(installerTaskFields);
      return task;
    });
    res.json(saved);
  }),
);
router.get(
  "/jobs/:id/updates",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await readInstallerJob(req.auth!, jobId(req), (tx) =>
        tx
          .select(updates)
          .from(jobUpdatesTable)
          .where(
            and(
              eq(jobUpdatesTable.jobId, jobId(req)),
              eq(jobUpdatesTable.authorId, req.auth!.userId),
            ),
          )
          .orderBy(desc(jobUpdatesTable.createdAt), desc(jobUpdatesTable.id))
          .limit(50),
      ),
    );
  }),
);
router.post(
  "/jobs/:id/updates",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const data = parse(
      z
        .object({
          id: z.string().uuid(),
          message: z.string().trim().min(1).max(1500),
        })
        .strict(),
      req.body,
    );
    const result = await writeInstallerJob(
      req.auth!,
      jobId(req),
      async (tx) => {
        const [author] = await tx
          .select({ name: usersTable.name })
          .from(usersTable)
          .where(eq(usersTable.id, req.auth!.userId));
        if (!author)
          throw new DomainError(403, "The author could not be verified.");
        const [created] = await tx
          .insert(jobUpdatesTable)
          .values({
            ...data,
            jobId: jobId(req),
            authorId: req.auth!.userId,
            authorName: author.name,
            createdAt: new Date().toISOString(),
          })
          .onConflictDoNothing()
          .returning(updates);
        if (created) return { status: 201, update: created };
        const [existing] = await tx
          .select({
            ...updates,
            jobId: jobUpdatesTable.jobId,
            authorId: jobUpdatesTable.authorId,
          })
          .from(jobUpdatesTable)
          .where(eq(jobUpdatesTable.id, data.id));
        if (
          !existing ||
          existing.jobId !== jobId(req) ||
          existing.authorId !== req.auth!.userId ||
          existing.message !== data.message
        )
          throw new DomainError(
            409,
            "This update ID already belongs to a different entry.",
          );
        const { jobId: _job, authorId: _author, ...update } = existing;
        return { status: 200, update };
      },
    );
    res.status(result.status).json(result.update);
  }),
);
router.get(
  "/jobs/:id/entry-context",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await readInstallerJob(req.auth!, jobId(req), async (tx) => {
        const bookings = await tx
          .select({
            id: crewBookingsTable.id,
            crewId: crewBookingsTable.crewId,
            crewName: crewsTable.name,
            startAt: crewBookingsTable.startAt,
            endAt: crewBookingsTable.endAt,
            status: crewBookingsTable.status,
          })
          .from(crewBookingsTable)
          .innerJoin(crewsTable, eq(crewsTable.id, crewBookingsTable.crewId))
          .where(
            and(
              eq(crewBookingsTable.jobId, jobId(req)),
              installerBookingAccess(req.auth!),
            ),
          );
        return {
          crews: [
            ...new Map(
              bookings.map((b) => [
                b.crewId,
                { id: b.crewId, name: b.crewName },
              ]),
            ).values(),
          ],
          bookings: bookings.map(({ crewName: _name, ...b }) => b),
          callbacks: [],
          materials: await tx
            .select(materials)
            .from(jobMaterialsTable)
            .where(eq(jobMaterialsTable.jobId, jobId(req))),
        };
      }),
    );
  }),
);
router.get(
  "/jobs/:id/materials",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await readInstallerJob(req.auth!, jobId(req), (tx) =>
        tx
          .select(materials)
          .from(jobMaterialsTable)
          .where(eq(jobMaterialsTable.jobId, jobId(req))),
      ),
    );
  }),
);
router.get(
  "/jobs/:id/photos",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await readInstallerJob(req.auth!, jobId(req), (tx) =>
        tx
          .select(photos)
          .from(jobPhotosTable)
          .where(eq(jobPhotosTable.jobId, jobId(req))),
      ),
    );
  }),
);
router.post(
  "/jobs/:id/photos",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const data = parse(
      z
        .object({
          stage: z.string().refine((v) => JOB_STAGES.includes(v)),
          objectPath: z.string().min(1).max(500),
          caption: z.string().max(1500).optional(),
        })
        .strict(),
      req.body,
    );
    const objectPath = storedFilePath(data.objectPath);
    const photo = await writeInstallerJob(req.auth!, jobId(req), async (tx) => {
      // Installer capture is private; customer portal publication requires office review.
      await assertOwnedFile(
        objectPath,
        ["job-photo"],
        req.auth!.userId,
        jobId(req),
      );
      const [saved] = await tx
        .insert(jobPhotosTable)
        .values({
          id: randomUUID(),
          jobId: jobId(req),
          stage: data.stage,
          objectPath,
          caption: data.caption ?? "",
          createdAt: new Date().toISOString(),
        })
        .returning(photos);
      return saved;
    });
    res.status(201).json(photo);
  }),
);
router.get(
  "/jobs/:id/labor",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await readInstallerJob(req.auth!, jobId(req), (tx) =>
        tx
          .select(labor)
          .from(laborEntriesTable)
          .where(
            and(
              eq(laborEntriesTable.jobId, jobId(req)),
              sql`EXISTS (SELECT 1 FROM ${crewBookingsTable} WHERE ${crewBookingsTable.id} = ${laborEntriesTable.bookingId} AND ${crewBookingsTable.jobId} = ${laborEntriesTable.jobId} AND ${crewBookingsTable.crewId} = ${laborEntriesTable.crewId} AND ${installerBookingAccess(req.auth!)})`,
            ),
          ),
      ),
    );
  }),
);
router.post(
  "/jobs/:id/labor",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const data = parse(
      z
        .object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .refine(
              (v) =>
                Number.isFinite(Date.parse(v + "T00:00:00Z")) &&
                new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v,
            ),
          crewId: z.string().min(1).max(200),
          bookingId: z.string().min(1).max(200),
          hours: z.number().finite().positive().max(24),
          notes: z.string().max(1500).optional(),
        })
        .strict(),
      req.body,
    );
    const row = await writeInstallerJob(req.auth!, jobId(req), async (tx) => {
      const booking = await lockInstallerBooking(
        tx,
        req.auth!,
        jobId(req),
        data.bookingId,
        data.crewId,
      );
      const [crew] = await tx
        .select({ name: crewsTable.name })
        .from(crewsTable)
        .where(eq(crewsTable.id, booking.crewId));
      if (!crew)
        throw new DomainError(403, "The assigned crew is unavailable.");
      const [saved] = await tx
        .insert(laborEntriesTable)
        .values({
          id: randomUUID(),
          jobId: jobId(req),
          date: data.date,
          crewId: booking.crewId,
          bookingId: booking.id,
          crew: crew.name,
          hours: data.hours,
          notes: data.notes ?? "",
          createdAt: new Date().toISOString(),
        })
        .returning(labor);
      return saved;
    });
    res.status(201).json(row);
  }),
);
router.get(
  "/jobs/:id/material-usage",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await readInstallerJob(req.auth!, jobId(req), (tx) =>
        tx
          .select({
            id: materialUsageTable.id,
            jobId: materialUsageTable.jobId,
            material: materialUsageTable.material,
            quantity: materialUsageTable.quantity,
            createdAt: materialUsageTable.createdAt,
          })
          .from(materialUsageTable)
          .where(eq(materialUsageTable.jobId, jobId(req))),
      ),
    );
  }),
);

// The storage router applies its own assignment checks before metadata/byte
// access and keeps assignment locks during uploads. All other installer routes
// fail closed here, including generic job PATCH/POST/DELETE and task creation.
router.get("/workspace-brand", (_req, _res, next) => next("router"));
router.get("/storage/objects/*path", (_req, _res, next) => next("router"));
router.post("/storage/files/job-photo", (_req, _res, next) => next("router"));
router.use("/work-guides", (_req, _res, next) => next("router"));
router.use((_req, res) =>
  res
    .status(403)
    .json({
      error:
        "This action requires an office role. Installers may use only assigned operational work.",
    }),
);
export default boundary;
