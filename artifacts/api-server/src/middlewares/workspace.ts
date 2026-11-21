import type { RequestHandler } from "express";
import { inWorkspace, workspaceConfigs, workspaceForHost } from "@workspace/db/workspace";

export const workspaceBoundary: RequestHandler = (req, res, next) => {
  if (!workspaceConfigs.length) { next(); return; }
  // Select only a configured host from the infrastructure's preserved Host header.
  // Express's hostname can use a forwarded header when trust proxy is enabled.
  const host = req.get("host");
  const workspace = workspaceForHost(host);
  if (!workspace) {
    if (host === process.env.CATALYST_WORKSPACE_HEALTH_HOST && host &&
      (req.method === "GET" || req.method === "HEAD") && req.path === "/api/healthz") {
      res.set("Cache-Control", "no-store").json({ status: "ok" });
      return;
    }
    res.status(421).set("Cache-Control", "no-store").json({ error: "This workspace address is unavailable." });
    return;
  }
  const origin = req.get("origin");
  if (origin && origin !== workspace.origin) {
    res.status(403).set("Cache-Control", "no-store").json({ error: "Use this workspace's own website." });
    return;
  }
  if (req.path === "/api" || req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  inWorkspace(workspace, next);
};
