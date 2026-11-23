import { Router } from "express";
import { z } from "zod";
import { domainRoute, id, parse } from "../lib/domain-http";
import { requireRole } from "../middlewares/auth";
import {
  guideWorkOrder,
  listGuideJobs,
  readWorkGuide,
  saveGuideUpdate,
} from "../lib/work-guides";
const router = Router();
router.use("/work-guides", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get(
  "/work-guides/jobs/:id/work-order",
  requireRole("owner", "sales", "operations", "installer"),
  domainRoute(async (req, res) => {
    parse(z.object({}).strict(), req.query);
    res.json(await guideWorkOrder(req.auth!, id(req)));
  }),
);
router.use("/work-guides", requireRole("owner", "operations", "installer"));
router.get(
  "/work-guides/jobs",
  domainRoute(async (req, res) => {
    const query = parse(
      z.object({ q: z.string().trim().max(80).optional() }).strict(),
      req.query,
    );
    res.json(await listGuideJobs(req.auth!, query.q ?? ""));
  }),
);
router.get(
  "/work-guides/jobs/:id",
  domainRoute(async (req, res) => {
    const query = parse(
      z.object({ order: z.string().min(1).max(200).optional() }).strict(),
      req.query,
    );
    res.json(await readWorkGuide(req.auth!, id(req), query.order));
  }),
);
router.post(
  "/work-guides/jobs/:id/updates",
  domainRoute(async (req, res) => {
    parse(z.object({}).strict(), req.query);
    const data = parse(
      z
        .object({
          id: z.string().uuid(),
          message: z.string().trim().min(1).max(1500),
        })
        .strict(),
      req.body,
    );
    const saved = await saveGuideUpdate(req.auth!, id(req), data);
    res.status(saved.status).json(saved.update);
  }),
);
export default router;
