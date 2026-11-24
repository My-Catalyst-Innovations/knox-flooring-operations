import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse } from "../lib/domain-http";
import {
  accountingCaseOptions,
  accountingChoiceSchema,
  accountingNoteSchema,
  appendAccountingCaseEvent,
  createAccountingCase,
  previewAccountingCase,
} from "../lib/inventory-accounting-cases";
const router: IRouter = Router();
const base = "/quickbooks/inventory-accounting-cases";
const id = z.string().min(1).max(200);
router.get(
  `${base}/options`,
  requireOwner,
  domainRoute(async (req, res) => {
    res.json(
      await accountingCaseOptions(
        parse(z.object({ productId: id }).strict(), req.query).productId,
      ),
    );
  }),
);
router.post(
  `${base}/preview`,
  requireOwner,
  domainRoute(async (req, res) => {
    res.json(
      await previewAccountingCase(parse(accountingChoiceSchema, req.body)),
    );
  }),
);
router.post(
  base,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          choice: accountingChoiceSchema,
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          requestKey: z.string().uuid(),
          confirmNoFinancialPosting: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const result = await createAccountingCase(
      input.choice,
      input.fingerprint,
      input.requestKey,
      req.auth!.userId,
    );
    res.status(result.replayed ? 200 : 201).json(result);
  }),
);
router.post(
  `${base}/:id/notes`,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({ requestKey: z.string().uuid(), note: accountingNoteSchema })
        .strict(),
      req.body,
    );
    res.json(
      await appendAccountingCaseEvent(
        parse(id, req.params.id),
        input.requestKey,
        input.note,
        req.auth!.userId,
      ),
    );
  }),
);
router.post(
  `${base}/:id/verify-adjustment`,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          requestKey: z.string().uuid(),
          note: accountingNoteSchema,
          adjustmentId: z.string().regex(/^\d{1,30}$/),
        })
        .strict(),
      req.body,
    );
    res.json(
      await appendAccountingCaseEvent(
        parse(id, req.params.id),
        input.requestKey,
        input.note,
        req.auth!.userId,
        input.adjustmentId,
      ),
    );
  }),
);
export default router;
