import { Router } from "express";
import { z } from "zod";
import {
  inspectCustomerCsv,
  customerImportFields,
  customerImportMaxBytes,
} from "@workspace/domain";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse, revision } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import {
  approveCustomerImport,
  commitCustomerImport,
  customerImportProvenance,
  listCustomerImports,
  previewCustomerImport,
  readCustomerImport,
  refreshCustomerImport,
  reviewCustomerImport,
} from "../lib/customer-imports";
const router = Router();
router.use("/customer-imports", requireOwner);
const csvInput = z
  .object({
    csv: z.string().max(customerImportMaxBytes),
    delimiter: z.enum([",", "\t"]).default(","),
  })
  .strict();
const mapping = z
  .object(
    Object.fromEntries(
      customerImportFields.map((field) => [
        field,
        z.string().min(1).max(120).optional(),
      ]),
    ),
  )
  .strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
router.get(
  "/customer-imports",
  domainRoute(async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await listCustomerImports());
  }),
);
router.post(
  "/customer-imports/inspect",
  domainRoute(async (req, res) => {
    const input = parse(csvInput, req.body);
    try {
      const { records: _records, ...preview } = inspectCustomerCsv(
        input.csv,
        input.delimiter,
      );
      res.json(preview);
    } catch (error) {
      throw new DomainError(
        400,
        error instanceof Error ? error.message : "Correct the customer CSV.",
      );
    }
  }),
);
router.post(
  "/customer-imports/preview",
  domainRoute(async (req, res) => {
    const input = parse(
      csvInput.extend({
        mapping,
        sourceSystem: z
          .string()
          .trim()
          .regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
        batchKey: z.string().trim().min(1).max(120),
        fileName: z.string().trim().min(1).max(200),
      }),
      req.body,
    );
    res
      .status(201)
      .json(
        await previewCustomerImport(
          { ...input, delimiter: input.delimiter ?? "," },
          req.auth!.userId,
        ),
      );
  }),
);
router.get(
  "/customer-imports/provenance/:customerId",
  domainRoute(async (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json(await customerImportProvenance(String(req.params.customerId)));
  }),
);
router.get(
  "/customer-imports/:id",
  domainRoute(async (req, res) => {
    res
      .set("Cache-Control", "no-store")
      .json(await readCustomerImport(String(req.params.id)));
  }),
);
router.post(
  "/customer-imports/:id/refresh",
  domainRoute(async (req, res) => {
    const input = parse(z.object({ revision }).strict(), req.body);
    res.json(
      await refreshCustomerImport(
        String(req.params.id),
        input.revision,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/customer-imports/:id/review",
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          revision,
          previewFingerprint: fingerprint,
          note: z.string().trim().min(5).max(1000),
          decisions: z
            .array(
              z
                .object({
                  line: z.number().int().positive(),
                  action: z.enum(["create", "link", "skip"]),
                  customerId: z.string().optional(),
                  customerRevision: revision.optional(),
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
      await reviewCustomerImport(
        String(req.params.id),
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
  "/customer-imports/:id/approve",
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          revision,
          reviewFingerprint: fingerprint,
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await approveCustomerImport(
        String(req.params.id),
        input.revision,
        input.reviewFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/customer-imports/:id/commit",
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          revision,
          approvalId: z.string().uuid(),
          approvalFingerprint: fingerprint,
        })
        .strict(),
      req.body,
    );
    res.json(
      await commitCustomerImport(
        String(req.params.id),
        input.revision,
        input.approvalId,
        input.approvalFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
export default router;
