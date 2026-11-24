import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { domainRoute, parse } from "../lib/domain-http";
import { requireOwner } from "../middlewares/auth";
import {
  readSmsPreference,
  recordSmsConsent,
  suppressSmsRecipient,
} from "../lib/sms-preferences";

const router = Router();
const base = "/sms-preferences";
router.use(base, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!req.auth || !["owner", "sales", "operations"].includes(req.auth.role)) {
    res
      .status(403)
      .json({ error: "Text preferences are available to office staff only." });
    return;
  }
  next();
});
const common = {
  to: z.string().trim().min(1).max(50),
  revision: z.number().int().nonnegative(),
  requestKey: z.string().uuid(),
};
function noPreview(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.previewRole) {
    res
      .status(403)
      .json({ error: "Exit role preview before changing text preferences." });
    return;
  }
  next();
}
router.get(
  `${base}/recipient`,
  domainRoute(async (req, res) => {
    const input = parse(z.object({ to: common.to }).strict(), req.query);
    res.json(await readSmsPreference(input.to));
  }),
);
router.post(
  `${base}/consent`,
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({
          ...common,
          bindingFingerprint: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          evidence: z
            .object({
              source: z.enum([
                "written",
                "web_form",
                "verbal",
                "inbound_request",
              ]),
              occurredAt: z.string().max(40),
              note: z.string().trim().min(10).max(1500),
              reference: z.string().trim().max(500),
              synthetic: z.boolean(),
            })
            .strict(),
          releaseSuppression: z.boolean(),
        })
        .strict(),
      req.body,
    );
    res.json(await recordSmsConsent(req.auth!.userId, input));
  }),
);
router.post(
  `${base}/suppress`,
  noPreview,
  domainRoute(async (req, res) => {
    const input = parse(
      z
        .object({ ...common, note: z.string().trim().min(5).max(1500) })
        .strict(),
      req.body,
    );
    res.json(await suppressSmsRecipient(req.auth!.userId, input));
  }),
);
export default router;
