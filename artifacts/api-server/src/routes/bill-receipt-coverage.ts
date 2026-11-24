import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse } from "../lib/domain-http";
import {
  approveBillReceiptCoverage,
  coverageBillStatus,
  coverageChoiceSchema,
  coverageOptions,
  previewBillReceiptCoverage,
} from "../lib/bill-receipt-coverage";
import {
  attachVendorBillDocument,
  downloadVendorBillDocument,
  listVendorBillDocuments,
} from "../lib/vendor-bill-documents";
const router: IRouter = Router();
const base = "/quickbooks/receipt-coverage";
const id = z.string().min(1).max(200);
router.get(
  `${base}/options`,
  requireOwner,
  domainRoute(async (req, res) => {
    res.json(
      await coverageOptions(
        parse(z.object({ billId: id }).strict(), req.query).billId,
      ),
    );
  }),
);
router.get(
  `${base}/bills/:id`,
  requireOwner,
  domainRoute(async (req, res) => {
    res.json(await coverageBillStatus(parse(id, req.params.id)));
  }),
);
router.post(
  `${base}/preview`,
  requireOwner,
  domainRoute(async (req, res) => {
    res.json(
      await previewBillReceiptCoverage(parse(coverageChoiceSchema, req.body)),
    );
  }),
);
router.post(
  `${base}/approve`,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          requestKey: z.string().uuid(),
          choice: coverageChoiceSchema,
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          confirmQuantities: z.literal(true),
          confirmPriceVariances: z.literal(true),
          confirmSourceIdentities: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const result = await approveBillReceiptCoverage(
      input.choice,
      input.fingerprint,
      input.requestKey,
      req.auth!.userId,
    );
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);
router.get(
  "/quickbooks/vendor-bills/:id/documents",
  requireOwner,
  domainRoute(async (req, res) => {
    res.json(await listVendorBillDocuments(parse(id, req.params.id)));
  }),
);
router.post(
  "/quickbooks/vendor-bills/:id/documents",
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          objectPath: z.string().min(1).max(1000),
          requestKey: z.string().uuid(),
        })
        .strict(),
      req.body,
    );
    const result = await attachVendorBillDocument(
      parse(id, req.params.id),
      input.objectPath,
      input.requestKey,
      req.auth!.userId,
    );
    res.status(result.status).json(result.document);
  }),
);
router.get(
  "/quickbooks/vendor-bills/documents/:id/download",
  requireOwner,
  domainRoute(async (req, res) => {
    const result = await downloadVendorBillDocument(
      parse(z.string().uuid(), req.params.id),
    );
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="original-bill"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/'/g, "%27")}`,
    );
    res.send(result.bytes);
  }),
);
export default router;
