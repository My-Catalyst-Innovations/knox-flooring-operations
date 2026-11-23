import express from "express";
import Stripe from "stripe";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ControlPool, ProvisioningClient } from "@workspace/db/control";
import {
  closeWorkspaceConnections,
  leaseWorkspaceConnection,
} from "@workspace/db";
import {
  inWorkspace,
  installWorkspaceResolver,
  registerTrustedWorkspace,
  workspaceConfigs,
  workspaceForHost,
  type WorkspaceConfig,
} from "@workspace/db/workspace";
import { createPlatform } from "../../catalyst-platform/src/index.mjs";
import { prepareWorkspaceOwner } from "./routes/staff";
import { startAutoSync, stopAutoSync } from "./lib/sync-measurements";
import {
  startQuickBooksWorker,
  stopQuickBooksWorker,
} from "./lib/quickbooks-worker";
import {
  startOutlookBookingWorker,
  stopOutlookBookingWorker,
} from "./lib/outlook-calendar";
import { logger } from "./lib/logger";
import { assertWorkspaceReady } from "./lib/workspace-readiness";

type Tenant = {
  workspaceKey: string;
  origin: string;
  databaseUrl: string;
  storageAccount: string;
  container: string;
};
function workspace(input: Tenant): WorkspaceConfig {
  return registerTrustedWorkspace({
    key: input.workspaceKey,
    origin: input.origin,
    host: new URL(input.origin).hostname,
    databaseUrl: input.databaseUrl,
    poolMax: 2,
    environment: Object.freeze({
      APP_BASE_URL: input.origin,
      AZURE_STORAGE_ACCOUNT_URL: input.storageAccount,
      AZURE_STORAGE_CONTAINER: input.container,
      IDENTITY_ENDPOINT: process.env.IDENTITY_ENDPOINT,
      IDENTITY_HEADER: process.env.IDENTITY_HEADER,
      COMMS_DELIVERY_MODE: "capture",
      DEMO_MODE: "false",
      DEMO_ACCESS_ENABLED: "false",
      BACKGROUND_WORKERS_ENABLED: "true",
      OUTLOOK_REDIRECT_URI: `${input.origin}/api/calendar/outlook/callback`,
      QUICKBOOKS_REDIRECT_URI: `${input.origin}/api/quickbooks/callback`,
    }),
  });
}
async function scoped<T>(selected: WorkspaceConfig, action: () => Promise<T>) {
  const release = await leaseWorkspaceConnection(selected);
  try {
    return await inWorkspace(selected, action);
  } finally {
    await release();
  }
}
export const platform = createPlatform({
  express,
  Stripe,
  Pool: ControlPool,
  Client: ProvisioningClient,
  migrationDirectory: path.resolve(
    process.cwd(),
    "artifacts/catalyst-platform/migrations",
  ),
  log: (event: { code: string; area: string }) =>
    logger.warn(event, "Company platform requires attention"),
  runtime: {
    reservedOrigins: workspaceConfigs.map((value) => value.origin),
    registerTenant: async (input: Tenant) => workspace(input),
    prepareOwner: async (
      input: Tenant & { company: string; name: string; email: string },
    ) =>
      scoped(workspace(input), () =>
        prepareWorkspaceOwner({
          company: input.company,
          name: input.name,
          email: input.email,
          adopt: false,
        }),
      ),
    migrateTenant: async (url: string) => {
      const runner = await import(
        pathToFileURL(
          path.resolve(process.cwd(), "lib/db/scripts/migration-runner.mjs"),
        ).href
      );
      const client = new ProvisioningClient({
        connectionString: url,
        connectionTimeoutMillis: 8000,
      });
      await client.connect();
      try {
        return (
          await runner.runMigrations(client, {
            migrations: await runner.loadMigrations(),
            expectedColumns: await runner.loadExpectedColumns(),
            expectedForeignKeys: await runner.loadExpectedForeignKeys(),
          })
        ).version;
      } finally {
        await client.end();
      }
    },
    ownerActivated: async (url: string, email: string) => {
      const client = new ProvisioningClient({
        connectionString: url,
        connectionTimeoutMillis: 8000,
      });
      await client.connect();
      try {
        return !!(
          await client.query(
            "SELECT id FROM users WHERE email=$1 AND role='owner' AND active=true LIMIT 1",
            [email],
          )
        ).rows.length;
      } finally {
        await client.end();
      }
    },
  },
});

function canonicalHost(origin: string | undefined) {
  try {
    return origin ? new URL(origin).host : undefined;
  } catch {
    return undefined;
  }
}
export function isLegacyPlatformHost(
  host: string | undefined,
  requestPath: string,
  method: string,
) {
  if (host === canonicalHost(process.env.APP_BASE_URL)) return true;
  return (
    (method === "GET" || method === "HEAD") &&
    requestPath === "/api/healthz" &&
    [
      process.env.WEBSITE_HOSTNAME,
      process.env.CATALYST_WORKSPACE_HEALTH_HOST,
    ].includes(host)
  );
}
if (platform.enabled)
  installWorkspaceResolver((host, requestPath) =>
    platform.resolveTenant(host, requestPath),
  );

const running = new Map<string, WorkspaceConfig>();
let registryTimer: NodeJS.Timeout | undefined;
let registryRefreshing = false;
function stopWorkers(selected: WorkspaceConfig) {
  inWorkspace(selected, () => {
    stopAutoSync();
    stopQuickBooksWorker();
    stopOutlookBookingWorker();
  });
}
async function refreshTenantWorkers() {
  if (registryRefreshing) return;
  registryRefreshing = true;
  const ready = new Set<string>();
  try {
    const { store } = await platform.getServices();
    const result = await store.query(
      "SELECT t.origin FROM platform_tenants t JOIN platform_organizations o ON o.id=t.organization_id WHERE o.state='ready' AND o.entitlement IN ('paid','trial','grandfathered') AND t.ready_at IS NOT NULL",
    );
    for (const row of result.rows as Array<{ origin: string }>) {
      try {
        const value = await platform.resolveTenant(
          new URL(row.origin).host,
          "/api/_worker",
        );
        if (!value) continue;
        const selected = registerTrustedWorkspace(value);
        ready.add(selected.key);
        if (running.get(selected.key) === selected) continue;
        if (running.has(selected.key)) stopWorkers(selected);
        await scoped(selected, async () => {
          await assertWorkspaceReady(selected);
          startAutoSync();
          startQuickBooksWorker();
          startOutlookBookingWorker();
        });
        running.set(selected.key, selected);
      } catch {
        /* One unavailable tenant must not stop the other companies. */
      }
    }
  } catch {
    /* Fail closed for dynamic workers; existing configured company workers are separate. */
  } finally {
    for (const [key, old] of running)
      if (!ready.has(key)) {
        const selected = workspaceForHost(old.host) ?? old;
        stopWorkers(selected);
        running.delete(key);
      }
    registryRefreshing = false;
  }
}
export function startPlatformServices() {
  if (
    !platform.enabled ||
    process.env.READ_ONLY_RECOVERY === "true" ||
    process.env.BACKGROUND_WORKERS_ENABLED === "false"
  )
    return;
  platform.startBillingWorker();
  void refreshTenantWorkers();
  registryTimer = setInterval(() => void refreshTenantWorkers(), 30_000);
  registryTimer.unref();
}
export async function closePlatformServices() {
  clearInterval(registryTimer);
  for (const selected of running.values())
    stopWorkers(workspaceForHost(selected.host) ?? selected);
  running.clear();
  await platform.close();
  await closeWorkspaceConnections();
}
