import app from "./app";
import { logger } from "./lib/logger";
import { startAutoSync } from "./lib/sync-measurements";
import { bootstrapOwner } from "./routes/auth";
import { startQuickBooksWorker } from "./lib/quickbooks-worker";
import { startOutlookBookingWorker } from "./lib/outlook-calendar";
import { closeWorkspaceConnections } from "@workspace/db";
import { inWorkspace, workspaceConfigs, workspaceEnvironment } from "@workspace/db/workspace";
import { assertWorkspaceReady } from "./lib/workspace-readiness";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start() {
  // Migrations run as an explicit release command before this process starts.
  // Refuse traffic if that step was missed; never seed or rewrite business data.
  if (workspaceConfigs.length) {
    for (const workspace of workspaceConfigs) await inWorkspace(workspace, () => assertWorkspaceReady(workspace));
  } else {
    await assertWorkspaceReady();
    if (process.env.READ_ONLY_RECOVERY !== "true") await bootstrapOwner();
  }
  app.listen(port, process.env.HOST || "0.0.0.0", (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    // Rehearsal databases must not process restored integration queues.
    if (process.env.BACKGROUND_WORKERS_ENABLED !== "false" && process.env.READ_ONLY_RECOVERY !== "true") {
      const startWorkspaceWorkers = () => {
        if (workspaceEnvironment().BACKGROUND_WORKERS_ENABLED === "false") return;
        startAutoSync();
        startQuickBooksWorker();
        startOutlookBookingWorker();
      };
      if (workspaceConfigs.length)
        for (const workspace of workspaceConfigs) inWorkspace(workspace, startWorkspaceWorkers);
      else
        startWorkspaceWorkers();
    } else {
      logger.info("Background integration workers are disabled");
    }
  });
}

start().catch(async (error) => {
  logger.error({ error }, "Application initialization failed; no traffic accepted");
  await closeWorkspaceConnections();
  process.exitCode = 1;
});
