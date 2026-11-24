import { Router } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { openPoImportColumns, openPoImportMaxBytes } from "@workspace/domain";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse, revision } from "../lib/domain-http";
import { safeFileHeaders } from "../lib/file-store";
import {
  approveOpenPoImport,
  commitOpenPoImport,
  listOpenPoImports,
  openPoImportOptions,
  openPoImportProvenance,
  previewOpenPoImport,
  readOpenPoImport,
  readOpenPoSource,
  refreshOpenPoImport,
  reviewOpenPoImport,
} from "../lib/open-po-imports";
const router = Router(),
  base = "/open-po-imports";
router.use(base, requireOwner, (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}]/u.test(value));
const identifier = text(200),
  parameter = (value: unknown) => parse(z.string().uuid(), value);
const noQuery = (query: unknown) => parse(z.object({}).strict(), query);
function download(
  res: import("express").Response,
  name: string,
  bytes: Buffer,
) {
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
  `${base}/template`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    download(
      res,
      "catalyst-outstanding-po-v1.csv",
      Buffer.from(openPoImportColumns.join(",") + "\n", "utf8"),
    );
  }),
);
router.get(
  base,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await listOpenPoImports());
  }),
);
router.get(
  `${base}/options`,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          kind: z.enum(["supplier", "warehouse", "product", "job", "order"]),
          q: z.string().trim().max(80).default(""),
          page: z.coerce.number().int().min(0).max(1000).default(0),
        })
        .strict(),
      req.query,
    );
    res.json(
      await openPoImportOptions(input.kind, input.q ?? "", input.page ?? 0),
    );
  }),
);
router.post(
  `${base}/preview`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          sourceSystem: z
            .string()
            .trim()
            .regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
          batchKey: text(120),
          fileName: text(200),
          csv: z.string().min(1).max(openPoImportMaxBytes),
          delimiter: z.enum([",", "\t"]).default(","),
          sourceSnapshotAt: z.string().min(20).max(40),
          cutoverAt: z.string().min(20).max(40),
        })
        .strict(),
      req.body,
    );
    res
      .status(201)
      .json(
        await previewOpenPoImport(
          { ...input, delimiter: input.delimiter ?? "," },
          req.auth!.userId,
        ),
      );
  }),
);
router.get(
  `${base}/provenance/:orderId`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(
      await openPoImportProvenance(parse(identifier, req.params.orderId)),
    );
  }),
);
router.get(
  `${base}/:id/source`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    download(
      res,
      "catalyst-outstanding-po-source-v1.csv",
      Buffer.from(await readOpenPoSource(parameter(req.params.id)), "utf8"),
    );
  }),
);
router.get(
  `${base}/:id`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await readOpenPoImport(parameter(req.params.id)));
  }),
);
router.post(
  `${base}/:id/refresh`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(z.object({ revision }).strict(), req.body);
    res.json(
      await refreshOpenPoImport(
        parameter(req.params.id),
        input.revision,
        req.auth!.userId,
      ),
    );
  }),
);
const line = z
  .object({
    line: z.number().int().positive(),
    action: z.enum(["include", "skip"]),
    productId: identifier.optional(),
    productRevision: revision.optional(),
    note: z.string().trim().max(500).default(""),
    zeroCostReason: z.string().trim().min(10).max(500).optional(),
  })
  .strict();
const decision = z
  .object({
    sourcePoId: identifier,
    action: z.enum(["create", "link", "skip"]),
    note: z.string().trim().min(5).max(1000),
    supplierId: identifier.optional(),
    supplierRevision: revision.optional(),
    warehouseId: identifier.optional(),
    warehouseUpdatedAt: text(40).optional(),
    jobId: identifier.nullable().optional(),
    jobRevision: revision.optional(),
    jobUpdatedAt: text(40).optional(),
    orderId: identifier.optional(),
    orderRevision: revision.optional(),
    orderFingerprint: fingerprint.optional(),
    sourceOpenConfirmed: z.boolean().optional(),
    outstandingOnlyConfirmed: z.boolean().optional(),
    lines: z.array(line).min(1).max(100).optional(),
  })
  .strict();
router.post(
  `${base}/:id/review`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          previewFingerprint: fingerprint,
          note: z.string().trim().min(10).max(1000),
          decisions: z.array(decision).min(1).max(200),
        })
        .strict(),
      req.body,
    );
    res.json(
      await reviewOpenPoImport(
        parameter(req.params.id),
        input.revision,
        input.previewFingerprint,
        input.decisions.map((item) => ({
          ...item,
          lines: item.lines?.map((choice) => ({
            ...choice,
            note: choice.note ?? "",
          })),
        })),
        input.note,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  `${base}/:id/approve`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          reviewFingerprint: fingerprint,
          confirmOutstandingOnly: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await approveOpenPoImport(
        parameter(req.params.id),
        input.revision,
        input.reviewFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  `${base}/:id/commit`,
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          approvalId: z.string().uuid(),
          approvalFingerprint: fingerprint,
          confirmOutstandingOnly: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await commitOpenPoImport(
        parameter(req.params.id),
        input.revision,
        input.approvalId,
        input.approvalFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
export default router;
