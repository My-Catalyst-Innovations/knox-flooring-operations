import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import {
  QuickBooksProjectsError,
  projectId,
} from "../lib/quickbooks-projects-graph";
import {
  approveProjectLink,
  prepareProjectReview,
  projectCandidates,
  projectsCapability,
  readJobProjects,
  reconcileProjectReview,
  submitProjectReview,
} from "../lib/quickbooks-projects";
const router: IRouter = Router();
const company = z.object({ connectionId: z.string().min(1) });
const revision = z.number().int().positive();
const note = z.string().trim().min(1).max(1000);
const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  domainRoute(async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      if (error instanceof QuickBooksProjectsError)
        throw new DomainError(409, error.message);
      throw error;
    }
  });
router.get(
  "/quickbooks/projects/capability",
  requireOwner,
  route(async (_req, res) => res.json(await projectsCapability())),
);
router.post(
  "/quickbooks/projects/probe",
  requireOwner,
  route(async (req, res) => {
    const input = parse(company, req.body);
    const result = await projectsCapability();
    if (result.connection?.id !== input.connectionId)
      throw new DomainError(
        409,
        "The QuickBooks connection changed. Refresh this company.",
      );
    res.json(result);
  }),
);
router.get(
  "/quickbooks/projects/jobs/:jobId",
  requireOwner,
  route(async (req, res) =>
    res.json(await readJobProjects(String(req.params.jobId))),
  ),
);
router.get(
  "/quickbooks/projects/jobs/:jobId/candidates",
  requireOwner,
  route(async (req, res) => {
    const input = parse(company, req.query);
    res.json(
      await projectCandidates(String(req.params.jobId), input.connectionId),
    );
  }),
);
router.put(
  "/quickbooks/projects/jobs/:jobId/link",
  requireOwner,
  route(async (req, res) =>
    res.json(
      await approveProjectLink(
        String(req.params.jobId),
        parse(
          company.extend({
            jobRevision: revision,
            projectId,
            linkRevision: revision.optional(),
            note,
          }),
          req.body,
        ),
        req.auth!.userId,
      ),
    ),
  ),
);
router.post(
  "/quickbooks/projects/jobs/:jobId/create-review",
  requireOwner,
  route(async (req, res) =>
    res.json(
      await prepareProjectReview(
        String(req.params.jobId),
        parse(
          company.extend({
            jobRevision: revision,
            name: z.string().trim().min(1).max(100),
            description: z.string().max(3800).default(""),
          }),
          req.body,
        ),
        req.auth!.userId,
      ),
    ),
  ),
);
router.post(
  "/quickbooks/projects/reviews/:reviewId/submit",
  requireOwner,
  route(async (req, res) =>
    res.json(
      await submitProjectReview(
        String(req.params.reviewId),
        parse(
          company.extend({
            reviewRevision: revision,
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            note,
          }),
          req.body,
        ),
        req.auth!.userId,
      ),
    ),
  ),
);
router.post(
  "/quickbooks/projects/reviews/:reviewId/reconcile",
  requireOwner,
  route(async (req, res) =>
    res.json(
      await reconcileProjectReview(
        String(req.params.reviewId),
        parse(company.extend({ reviewRevision: revision }), req.body),
        req.auth!.userId,
      ),
    ),
  ),
);
export default router;
