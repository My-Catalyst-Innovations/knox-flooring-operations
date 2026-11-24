import { Router } from "express";
import { z } from "zod";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse } from "../lib/domain-http";
import {
  exportSavedCompanyConfiguration,
  readCompanySetup,
} from "../lib/company-setup";

const router = Router();
router.use("/company-setup", requireOwner);
router.get(
  "/company-setup/readiness",
  domainRoute(async (req, res) => {
    parse(z.object({}).strict(), req.query);
    res.setHeader("Cache-Control", "no-store");
    res.json(await readCompanySetup());
  }),
);
router.get(
  "/company-setup/configuration-export",
  domainRoute(async (req, res) => {
    parse(z.object({}).strict(), req.query);
    const result = await exportSavedCompanyConfiguration();
    res.set({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="catalyst-works-company-configuration-v1.json"',
      "X-Content-Type-Options": "nosniff",
    });
    res.send(JSON.stringify(result, null, 2));
  }),
);
export default router;
