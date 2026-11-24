import { Router } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  activeJobImportColumns,
  activeJobImportMaxBytes,
} from "@workspace/domain";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse, revision } from "../lib/domain-http";
import { safeFileHeaders } from "../lib/file-store";
import {
  activeJobImportChoices,
  activeJobSourceCsv,
  approveActiveJobImport,
  commitActiveJobImport,
  listActiveJobImports,
  previewActiveJobImport,
  readActiveJobImport,
  refreshActiveJobImport,
  reviewActiveJobImport,
} from "../lib/active-job-imports";
import {
  approveJobCutover,
  commitJobCutover,
  readJobCutover,
  reviewJobCutover,
} from "../lib/job-cutover";
const router = Router();
router.use("/active-job-imports", requireOwner, (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use("/jobs/:id/cutover", requireOwner, (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const plain = (maximum: number, minimum = 0) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine((value) => !/[\p{Cc}]/u.test(value));
const uuid = z.string().uuid(),
  fingerprint = z.string().regex(/^[a-f0-9]{64}$/),
  noQuery = (value: unknown) => parse(z.object({}).strict(), value);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ids = z.array(uuid).min(1).max(10);
const payload = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("operational"),
      targetStage: plain(80, 1),
      note: plain(2000, 10),
      confirmRealReadiness: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("financial_context"),
      fullJobRevenueCents: cents,
      fullJobLaborForecastCents: cents,
      fullJobMaterialForecastCents: cents,
      fullJobOtherForecastCents: cents,
      evidenceDocumentIds: ids,
      note: plain(2000, 10),
      confirmForecastOnly: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("billing"),
      worksGrossInvoiceCeilingAfterLegacyCents: cents,
      evidenceDocumentIds: ids,
      note: plain(2000, 10),
      confirmIncludesAllLegacyInvoices: z.literal(true),
      confirmNoLegacyBalancesCreated: z.literal(true),
    })
    .strict(),
]);
const parameter = (value: unknown) => parse(uuid, value);
function attachment(
  res: import("express").Response,
  name: string,
  source: string,
) {
  const bytes = Buffer.from(source, "utf8");
  res.set(
    safeFileHeaders(
      {
        name,
        type: "application/octet-stream",
        length: String(bytes.length),
        body: Readable.from(bytes),
      },
      true,
    ),
  );
  res.send(bytes);
}
router.get(
  "/active-job-imports/template",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    attachment(
      res,
      "catalyst-active-jobs-v1.csv",
      activeJobImportColumns.join(",") + "\n",
    );
  }),
);
router.get(
  "/active-job-imports/choices",
  domainRoute(async (req, res) => {
    const input = parse(
      z.object({ q: plain(80).default("") }).strict(),
      req.query,
    );
    res.json(await activeJobImportChoices(input.q ?? ""));
  }),
);
router.get(
  "/active-job-imports",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await listActiveJobImports());
  }),
);
router.post(
  "/active-job-imports/preview",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          sourceSystem: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
          batchKey: plain(120, 1),
          fileName: plain(200, 1),
          csv: z.string().min(1).max(activeJobImportMaxBytes),
          delimiter: z.enum([",", "\t"]).default(","),
        })
        .strict(),
      req.body,
    );
    res
      .status(201)
      .json(
        await previewActiveJobImport(
          { ...input, delimiter: input.delimiter ?? "," },
          req.auth!.userId,
        ),
      );
  }),
);
router.get(
  "/active-job-imports/:id/source",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    attachment(
      res,
      "catalyst-active-job-original-v1.csv",
      await activeJobSourceCsv(parameter(req.params.id)),
    );
  }),
);
router.get(
  "/active-job-imports/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await readActiveJobImport(parameter(req.params.id)));
  }),
);
router.post(
  "/active-job-imports/:id/refresh",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(z.object({ revision }).strict(), req.body);
    res.json(
      await refreshActiveJobImport(
        parameter(req.params.id),
        input.revision,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/active-job-imports/:id/review",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          previewFingerprint: fingerprint,
          note: plain(1000, 5),
          decisions: z
            .array(
              z
                .object({
                  line: z.number().int().positive(),
                  action: z.enum(["create", "link", "skip"]),
                  customerId: uuid.optional(),
                  customerRevision: revision.optional(),
                  siteId: uuid.nullable().optional(),
                  siteFingerprint: fingerprint.nullable().optional(),
                  jobId: uuid.optional(),
                  jobRevision: revision.optional(),
                  entryStage: plain(80, 1).optional(),
                  flooringType: plain(80, 1).optional(),
                  stageMappingReason: plain(1000).optional(),
                  acceptSourceDates: z.boolean().optional(),
                  note: plain(1000).default(""),
                })
                .strict(),
            )
            .min(1)
            .max(200),
        })
        .strict(),
      req.body,
    );
    res.json(
      await reviewActiveJobImport(
        parameter(req.params.id),
        input.revision,
        input.previewFingerprint,
        input.decisions.map((choice) => ({
          ...choice,
          note: choice.note ?? "",
        })),
        input.note,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/active-job-imports/:id/approve",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          reviewFingerprint: fingerprint,
          confirmNoFinancialOrOperationalSideEffects: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await approveActiveJobImport(
        parameter(req.params.id),
        input.revision,
        input.reviewFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/active-job-imports/:id/commit",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          approvalId: uuid,
          approvalFingerprint: fingerprint,
          confirmNoFinancialOrOperationalSideEffects: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await commitActiveJobImport(
        parameter(req.params.id),
        input.revision,
        input.approvalId,
        input.approvalFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
router.get(
  "/jobs/:id/cutover",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await readJobCutover(parameter(req.params.id)));
  }),
);
router.post(
  "/jobs/:id/cutover/reviews",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({ jobRevision: revision, cutoverRevision: revision, payload })
        .strict(),
      req.body,
    );
    res
      .status(201)
      .json(
        await reviewJobCutover(
          parameter(req.params.id),
          input.jobRevision,
          input.cutoverRevision,
          input.payload,
          req.auth!.userId,
        ),
      );
  }),
);
router.post(
  "/jobs/:id/cutover/reviews/:reviewId/approve",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(z.object({ fingerprint }).strict(), req.body);
    res.json(
      await approveJobCutover(
        parameter(req.params.id),
        parameter(req.params.reviewId),
        input.fingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/jobs/:id/cutover/reviews/:reviewId/commit",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z.object({ approvalId: uuid, fingerprint }).strict(),
      req.body,
    );
    res.json(
      await commitJobCutover(
        parameter(req.params.id),
        parameter(req.params.reviewId),
        input.approvalId,
        input.fingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
export default router;
