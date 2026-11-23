import type { RequestHandler } from "express";
import {
  inWorkspace,
  workspaceConfigs,
  resolveWorkspaceForHost,
  isDynamicWorkspace,
} from "@workspace/db/workspace";
import { leaseWorkspaceConnection } from "@workspace/db";
import { isLegacyPlatformHost, platform } from "../platform";
import { assertWorkspaceReady } from "../lib/workspace-readiness";

export const workspaceBoundary: RequestHandler = async (req, res, next) => {
  if (!workspaceConfigs.length && !platform.enabled) {
    next();
    return;
  }
  // Select only a configured host from the infrastructure's preserved Host header.
  // Express's hostname can use a forwarded header when trust proxy is enabled.
  const host = req.get("host");
  if (
    !workspaceConfigs.length &&
    platform.enabled &&
    isLegacyPlatformHost(host, req.path, req.method)
  ) {
    next();
    return;
  }
  let workspace;
  try {
    workspace = await resolveWorkspaceForHost(host, req.path);
  } catch (error) {
    const status =
      typeof error === "object" &&
      error &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 503;
    res
      .status(status)
      .set("Cache-Control", "no-store")
      .json({
        error:
          status === 402
            ? "This company requires subscription review."
            : "This company workspace is temporarily unavailable.",
      });
    return;
  }
  if (!workspace) {
    if (
      host === process.env.CATALYST_WORKSPACE_HEALTH_HOST &&
      host &&
      (req.method === "GET" || req.method === "HEAD") &&
      req.path === "/api/healthz"
    ) {
      res.set("Cache-Control", "no-store").json({ status: "ok" });
      return;
    }
    res
      .status(421)
      .set("Cache-Control", "no-store")
      .json({ error: "This workspace address is unavailable." });
    return;
  }
  const origin = req.get("origin");
  if (origin && origin !== workspace.origin) {
    res
      .status(403)
      .set("Cache-Control", "no-store")
      .json({ error: "Use this workspace's own website." });
    return;
  }
  if (req.path === "/api" || req.path.startsWith("/api/"))
    res.set("Cache-Control", "no-store");
  try {
    const release = await leaseWorkspaceConnection(workspace);
    try {
      if (isDynamicWorkspace(workspace.host))
        await inWorkspace(workspace, () => assertWorkspaceReady(workspace));
    } catch {
      await release();
      res
        .status(503)
        .json({
          error:
            "This company workspace is awaiting a verified software update.",
        });
      return;
    }
    const done = () => {
      void release();
    };
    res.once("finish", done);
    res.once("close", done);
    inWorkspace(workspace, next);
  } catch {
    res
      .status(503)
      .set("Retry-After", "5")
      .json({ error: "Company database capacity is busy. Retry shortly." });
  }
};
