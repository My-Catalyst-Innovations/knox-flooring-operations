import { Router } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  supplierImportColumns,
  supplierImportMaxBytes,
} from "@workspace/domain";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse, revision } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { safeFileHeaders } from "../lib/file-store";
import {
  activateSupplier,
  approveSupplierImport,
  commitSupplierImport,
  createSupplier,
  editSupplier,
  listSupplierImports,
  listSuppliers,
  previewSupplierImport,
  readSupplier,
  readSupplierImport,
  refreshSupplierImport,
  reviewSupplierImport,
  supplierSourceCsv,
} from "../lib/supplier-imports";

const router = Router();
for (const prefix of ["/suppliers", "/supplier-imports"])
  router.use(prefix, requireOwner, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
const parameter = (value: unknown) => parse(z.string().uuid(), value);
const noQuery = (value: unknown) => parse(z.object({}).strict(), value);
const plain = (maximum: number, minimum = 0) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine((value) => !/[\p{Cc}]/u.test(value));
const email = plain(320).refine(
  (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
);
const contact = z
  .object({
    contactName: plain(200).default(""),
    email: email.default(""),
    phone: plain(80).default(""),
    address: plain(500).default(""),
    city: plain(100).default(""),
    state: plain(100).default(""),
    postalCode: plain(30).default(""),
    country: plain(100).default(""),
    notes: z
      .string()
      .max(5000)
      .refine(
        (value) =>
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
      )
      .default(""),
  })
  .strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
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
  "/suppliers",
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          q: plain(80).optional(),
          active: z.enum(["active", "inactive", "all"]).default("active"),
          page: z.coerce.number().int().min(0).max(1000).default(0),
        })
        .strict(),
      req.query,
    );
    res.json(
      await listSuppliers({
        ...input,
        active: input.active ?? "active",
        page: input.page ?? 0,
      }),
    );
  }),
);
router.post(
  "/suppliers",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      contact.extend({ name: plain(200, 1) }).strict(),
      req.body,
    );
    res.status(201).json(
      await createSupplier(
        {
          name: input.name,
          contactName: input.contactName ?? "",
          email: input.email ?? "",
          phone: input.phone ?? "",
          address: input.address ?? "",
          city: input.city ?? "",
          state: input.state ?? "",
          postalCode: input.postalCode ?? "",
          country: input.country ?? "",
          notes: input.notes ?? "",
        },
        req.auth!.userId,
      ),
    );
  }),
);
router.get(
  "/suppliers/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await readSupplier(parameter(req.params.id)));
  }),
);
router.patch(
  "/suppliers/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const { revision: expected, ...fields } = parse(
      contact.partial().extend({ revision }).strict(),
      req.body,
    );
    if (!Object.keys(fields).length)
      throw new DomainError(
        400,
        "Choose a contact, address or notes field to update. Canonical supplier names cannot be renamed.",
      );
    res.json(
      await editSupplier(
        parameter(req.params.id),
        expected,
        fields,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/suppliers/:id/activation",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({ revision, active: z.boolean(), reason: plain(1000, 5) })
        .strict(),
      req.body,
    );
    res.json(
      await activateSupplier(
        parameter(req.params.id),
        input.revision,
        input.active,
        input.reason,
        req.auth!.userId,
      ),
    );
  }),
);
for (const method of ["delete", "post"] as const) {
  router[method](
    method === "delete" ? "/suppliers/:id" : "/suppliers/:id/merge",
    domainRoute(async (req) => {
      noQuery(req.query);
      await readSupplier(parameter(req.params.id));
      throw new DomainError(
        409,
        "Supplier deletion and merging are not supported. Retain canonical names and source links; deactivate the supplier instead. Existing purchasing labels remain unchanged.",
      );
    }),
  );
}
router.get(
  "/supplier-imports/template",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    attachment(
      res,
      "catalyst-supplier-contacts-v1.csv",
      supplierImportColumns.join(",") + "\n",
    );
  }),
);
router.get(
  "/supplier-imports",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await listSupplierImports());
  }),
);
router.post(
  "/supplier-imports/preview",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          sourceSystem: z
            .string()
            .trim()
            .regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
          batchKey: plain(120, 1),
          fileName: plain(200, 1),
          csv: z.string().min(1).max(supplierImportMaxBytes),
          delimiter: z.enum([",", "\t"]).default(","),
        })
        .strict(),
      req.body,
    );
    res
      .status(201)
      .json(
        await previewSupplierImport(
          { ...input, delimiter: input.delimiter ?? "," },
          req.auth!.userId,
        ),
      );
  }),
);
router.get(
  "/supplier-imports/:id/source",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    attachment(
      res,
      "catalyst-supplier-source-v1.csv",
      await supplierSourceCsv(parameter(req.params.id)),
    );
  }),
);
router.get(
  "/supplier-imports/:id",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    res.json(await readSupplierImport(parameter(req.params.id)));
  }),
);
router.post(
  "/supplier-imports/:id/refresh",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(z.object({ revision }).strict(), req.body);
    res.json(
      await refreshSupplierImport(
        parameter(req.params.id),
        input.revision,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/supplier-imports/:id/review",
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
                  supplierId: z.string().uuid().optional(),
                  supplierRevision: revision.optional(),
                  note: plain(500).default(""),
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
      await reviewSupplierImport(
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
  "/supplier-imports/:id/approve",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          reviewFingerprint: fingerprint,
          confirmContactsOnly: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await approveSupplierImport(
        parameter(req.params.id),
        input.revision,
        input.reviewFingerprint,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  "/supplier-imports/:id/commit",
  domainRoute(async (req, res) => {
    noQuery(req.query);
    const input = parse(
      z
        .object({
          revision,
          approvalId: z.string().uuid(),
          approvalFingerprint: fingerprint,
          confirmContactsOnly: z.literal(true),
        })
        .strict(),
      req.body,
    );
    res.json(
      await commitSupplierImport(
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
