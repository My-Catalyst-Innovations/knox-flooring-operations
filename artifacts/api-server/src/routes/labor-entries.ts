import { stripNulls } from "../lib/strip-nulls";
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  laborEntriesTable,
  jobsTable,
  crewsTable,
  crewBookingsTable,
  type LaborEntryInsert,
} from "@workspace/db";
import {
  ListLaborEntriesParams,
  ListLaborEntriesResponse,
  CreateLaborEntryParams,
  CreateLaborEntryBody,
  UpdateLaborEntryParams,
  UpdateLaborEntryBody,
  DeleteLaborEntryParams,
} from "@workspace/api-zod";

import { domainRoute } from "../lib/domain-http";
import { validateLaborReferences } from "../lib/entry-references";
import {
  assertCostSourceEditable,
  assertLaborNotReplaced,
} from "../lib/job-accounting";
const router: IRouter = Router();

router.get("/jobs/:id/labor", async (req, res): Promise<void> => {
  const params = ListLaborEntriesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rows = await db
    .select()
    .from(laborEntriesTable)
    .where(eq(laborEntriesTable.jobId, params.data.id));

  res.json(ListLaborEntriesResponse.parse(rows.map(stripNulls)));
});

router.post(
  "/jobs/:id/labor",
  domainRoute(async (req, res) => {
    const params = CreateLaborEntryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = CreateLaborEntryBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn(
        { diagnostic: "request_validation_failed" },
        "Invalid labor entry body",
      );
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [job] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, params.data.id));

    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    await validateLaborReferences(params.data.id, parsed.data, req.auth!.role);
    const values: LaborEntryInsert = {
      id: randomUUID(),
      jobId: params.data.id,
      date: parsed.data.date,
      crew: parsed.data.crew,
      crewId: parsed.data.crewId,
      bookingId: parsed.data.bookingId,
      callbackId: parsed.data.callbackId,
      hours: parsed.data.hours,
      notes: parsed.data.notes ?? "",
      createdAt: new Date().toISOString(),
    };

    const [row] = await db.insert(laborEntriesTable).values(values).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/jobs/:id/labor/:entryId",
  domainRoute(async (req, res) => {
    const params = UpdateLaborEntryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = UpdateLaborEntryBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn(
        { diagnostic: "request_validation_failed" },
        "Invalid labor entry update body",
      );
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(laborEntriesTable)
        .where(
          and(
            eq(laborEntriesTable.id, params.data.entryId),
            eq(laborEntriesTable.jobId, params.data.id),
          ),
        )
        .for("update");
      if (!existing) {
        res.status(404).json({ error: "Labor entry not found" });
        return;
      }
      await assertCostSourceEditable(tx, "labor", existing.id);
      await assertLaborNotReplaced(tx, existing.id);
      await validateLaborReferences(
        params.data.id,
        { ...existing, ...parsed.data },
        req.auth!.role,
      );
      const [row] = await tx
        .update(laborEntriesTable)
        .set({
          ...parsed.data,
          revision: existing.revision + 1,
          costReviewed: false,
          singleWorkerConfirmed: false,
        })
        .where(
          and(
            eq(laborEntriesTable.id, params.data.entryId),
            eq(laborEntriesTable.jobId, params.data.id),
          ),
        )
        .returning();

      if (!row) {
        res.status(404).json({ error: "Labor entry not found" });
        return;
      }

      return row;
    });
    if (result) res.json(result);
  }),
);

router.delete(
  "/jobs/:id/labor/:entryId",
  domainRoute(async (req, res): Promise<void> => {
    const params = DeleteLaborEntryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const row = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(laborEntriesTable)
        .where(
          and(
            eq(laborEntriesTable.id, params.data.entryId),
            eq(laborEntriesTable.jobId, params.data.id),
          ),
        )
        .for("update");
      if (!existing) return null;
      await assertCostSourceEditable(tx, "labor", existing.id);
      await assertLaborNotReplaced(tx, existing.id);
      const [deleted] = await tx
        .delete(laborEntriesTable)
        .where(
          and(
            eq(laborEntriesTable.id, params.data.entryId),
            eq(laborEntriesTable.jobId, params.data.id),
          ),
        )
        .returning();
      return deleted;
    });

    if (!row) {
      res.status(404).json({ error: "Labor entry not found" });
      return;
    }

    res.sendStatus(204);
  }),
);

export default router;
