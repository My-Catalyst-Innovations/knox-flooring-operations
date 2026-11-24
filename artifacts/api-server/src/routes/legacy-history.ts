import { Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  legacyArchiveColumns,
  legacyArchiveMaxBytes,
  legacyArchiveTypes,
} from "@workspace/domain";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse, revision } from "../lib/domain-http";
import { safeFileHeaders } from "../lib/file-store";
import {
  approveLegacyImport,
  attachLegacyDocument,
  commitLegacyImport,
  downloadLegacyDocument,
  legacySourceCsv,
  listLegacyImports,
  listLegacyRecords,
  previewLegacyImport,
  readLegacyImport,
  readLegacyRecord,
  refreshLegacyImport,
  reviewLegacyImport,
} from "../lib/legacy-history";
const router = Router();
router.use("/legacy-history", requireOwner, (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\p{Cc}]/u.test(value));
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const noQuery = (query: unknown) => parse(z.object({}).strict(), query);
const parameter = (value: unknown) => parse(z.string().uuid(), value);
function attachment(
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
  "/legacy-history/template",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    attachment(
      res,
      "catalyst-legacy-history-v1.csv",
      Buffer.from(legacyArchiveColumns.join(",") + "\n", "utf8"),
    );
  }),
);
router.get(
  "/legacy-history/imports",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await listLegacyImports());
  }),
);
router.post(
  "/legacy-history/imports/preview",
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
          csv: z.string().min(1).max(legacyArchiveMaxBytes),
          delimiter: z.enum([",", "\t"]).default(","),
        })
        .strict(),
      req.body,
    );
    res
      .status(201)
      .json(
        await previewLegacyImport(
          { ...input, delimiter: input.delimiter ?? "," },
          req.auth!.userId,
        ),
      );
  }),
);
router.get(
  "/legacy-history/imports/:id/source",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const source = await legacySourceCsv(parameter(req.params.id));
    attachment(
      res,
      "catalyst-legacy-source-v1.csv",
      Buffer.from(source, "utf8"),
    );
  }),
);
router.get(
  "/legacy-history/imports/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await readLegacyImport(parameter(req.params.id)));
  }),
);
router.post(
  "/legacy-history/imports/:id/refresh",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(z.object({ revision }).strict(), req.body);
    res.json(
      await refreshLegacyImport(
        parameter(req.params.id),
        input.revision,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/legacy-history/imports/:id/review",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          previewFingerprint: fingerprint,
          note: text(1000).refine((value) => value.length >= 5),
          decisions: z
            .array(
              z
                .object({
                  line: z.number().int().positive(),
                  action: z.enum(["archive", "skip"]),
                  note: z.string().trim().max(500).default(""),
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
      await reviewLegacyImport(
        parameter(req.params.id),
        input.revision,
        input.previewFingerprint,
        input.decisions.map((item) => ({ ...item, note: item.note ?? "" })),
        input.note,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/legacy-history/imports/:id/approve",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          reviewFingerprint: fingerprint,
          confirmReadOnly: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await approveLegacyImport(
        parameter(req.params.id),
        input.revision,
        input.reviewFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/legacy-history/imports/:id/commit",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          approvalId: z.string().uuid(),
          approvalFingerprint: fingerprint,
          confirmReadOnly: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await commitLegacyImport(
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
  "/legacy-history/documents/:id/download",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const source = await downloadLegacyDocument(parameter(req.params.id));
    const file = {
      body: Readable.from(source.bytes),
      name: source.name,
      type: "application/octet-stream",
      length: String(source.bytes.length),
    };
    res.set(safeFileHeaders(file, true));
    await pipeline(file.body, res).catch((error: unknown) => {
      if (!res.destroyed) throw error;
    });
  }),
);
router.get(
  "/legacy-history",
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          q: z.string().trim().max(80).optional(),
          type: z.enum(legacyArchiveTypes).optional(),
          sourceSystem: z
            .string()
            .regex(/^[a-z0-9][a-z0-9._-]{1,79}$/)
            .optional(),
          page: z.coerce.number().int().min(0).max(1000).default(0),
        })
        .strict(),
      req.query,
    );
    res.json(
      await listLegacyRecords({
        q: input.q,
        recordType: input.type,
        sourceSystem: input.sourceSystem,
        page: input.page ?? 0,
      }),
    );
  }),
);
router.get(
  "/legacy-history/:id/export",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const result = await readLegacyRecord(parameter(req.params.id));
    attachment(
      res,
      "catalyst-legacy-record-v1.json",
      Buffer.from(
        JSON.stringify(
          {
            format: "catalyst-works-legacy-history",
            schemaVersion: 1,
            historicalOnly: true,
            activeRecordsCreated: false,
            ...result,
          },
          null,
          2,
        ),
        "utf8",
      ),
    );
  }),
);
router.get(
  "/legacy-history/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await readLegacyRecord(parameter(req.params.id)));
  }),
);
router.post(
  "/legacy-history/:id/documents",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          objectPath: z.string().min(1).max(500),
          requestKey: z.string().uuid(),
          confirmOriginal: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const result = await attachLegacyDocument(
      parameter(req.params.id),
      input.objectPath,
      input.requestKey,
      req.auth!.userId,
    );
    res.status(result.status).json(result.document);
  }),
);
export default router;
