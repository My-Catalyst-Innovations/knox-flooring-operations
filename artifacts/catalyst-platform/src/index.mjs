import {
  readPlatformConfig,
  PlatformError,
  safeFailure,
  vaultReference,
  currentEntitlement,
} from "./config.mjs";
import { createVault } from "./vault.mjs";
import { openPlatformPool, migratePlatform, createStore } from "./store.mjs";
import { createBilling } from "./billing.mjs";
import { createPlatformMail } from "./email.mjs";
import { createService } from "./service.mjs";
import { createProvisioner } from "./provisioning.mjs";
import { createPlatformRouter } from "./router.mjs";
import { provisionedResources } from "./provisioning.mjs";

export function createPlatform({
  express,
  Stripe,
  Pool,
  Client,
  runtime,
  env = process.env,
  migrationDirectory,
  log = () => {},
  request = fetch,
}) {
  let config, configurationFailure;
  try {
    config = readPlatformConfig(env);
  } catch (error) {
    configurationFailure = error;
    config = {
      enabled: env.PLATFORM_ENABLED === "true",
      origin: env.PLATFORM_ORIGIN,
      plans: [],
      blockers: ["Company account configuration requires operator attention."],
    };
  }
  config.reservedOrigins = runtime.reservedOrigins ?? [];
  const readOnly = env.READ_ONLY_RECOVERY === "true";
  let resources,
    billingRunning = false,
    provisioningRunning = false,
    billingTimer,
    provisioningTimer;
  async function getServices({ allowUnmigrated = false } = {}) {
    if (!config.enabled || configurationFailure || !config.refs?.database)
      throw new PlatformError(
        503,
        "readiness",
        "Company account services are not configured.",
      );
    if (!resources)
      resources = (async () => {
        const vault = createVault(config, env, request),
          pool = await openPlatformPool(Pool, config, vault);
        try {
          if (!allowUnmigrated)
            await migratePlatform(pool, migrationDirectory, {
              checkOnly: true,
            });
        } catch (error) {
          await pool.end();
          throw error;
        }
        const store = createStore(pool),
          billing = createBilling({ Stripe, config, vault, store }),
          mail = createPlatformMail({ config, vault, store, request });
        const service = createService({ config, store, mail, billing }),
          provisioner = createProvisioner({
            Client,
            config,
            vault,
            store,
            mail,
            runtime,
            request,
          });
        return {
          vault,
          pool,
          store,
          billing,
          mail,
          service,
          provisioner,
          kick,
        };
      })().catch((error) => {
        resources = undefined;
        throw error;
      });
    return resources;
  }
  let readinessCached,
    readinessPending,
    readinessUntil = 0;
  async function loadReadiness() {
    const blockers = [...config.blockers];
    let plans = [];
    if (config.enabled && !configurationFailure && config.refs?.database) {
      try {
        const services = await getServices();
        if (config.refs.stripe) plans = await services.billing.plans();
      } catch (error) {
        blockers.push(
          error instanceof PlatformError
            ? error.message
            : "Company account infrastructure is unavailable.",
        );
      }
    }
    const customerBlockers = blockers.length
      ? [
          "Company signup is not available while subscription options and company account setup are finalized.",
        ]
      : readOnly
        ? ["Company account changes are temporarily unavailable."]
        : [];
    return {
      enabled: config.enabled,
      signupAvailable: config.enabled && blockers.length === 0 && !readOnly,
      blockers: customerBlockers,
      tenantDomain: config.suffix ?? null,
      termsUrl: config.termsUrl ?? null,
      privacyUrl: config.privacyUrl ?? null,
      trialDays: config.policyApproved ? (config.trialDays ?? 0) : 0,
      testMode: !config.liveMode,
      plans,
    };
  }
  async function readiness() {
    if (readinessCached && readinessUntil > Date.now()) return readinessCached;
    if (readinessPending) return readinessPending;
    readinessPending = loadReadiness()
      .then((result) => {
        readinessCached = result;
        readinessUntil = Date.now() + 30_000;
        return result;
      })
      .finally(() => {
        readinessPending = undefined;
      });
    return readinessPending;
  }
  async function probe(host) {
    const { store } = await getServices();
    const row = (
      await store.query(
        "SELECT t.workspace_key FROM platform_tenants t JOIN platform_organizations o ON o.id=t.organization_id WHERE t.origin=$1 AND o.entitlement IN ('paid','trial','grandfathered')",
        [`https://${host?.toLowerCase()}`],
      )
    ).rows[0];
    if (!row)
      throw new PlatformError(
        404,
        "workspace",
        "Company address is not provisioned.",
      );
    return { workspaceKey: row.workspace_key };
  }
  async function resolveTenant(host, path = "/") {
    if (!config.enabled || !host || host.includes(":")) return null;
    const origin = `https://${host.toLowerCase()}`;
    if (
      origin === config.legacyOrigin ||
      origin === config.origin ||
      config.reservedOrigins.includes(origin)
    )
      return null;
    const { store, vault } = await getServices();
    const row = (
      await store.query(
        "SELECT t.*,o.slug,o.state,o.entitlement,o.subscription_ends_at FROM platform_tenants t JOIN platform_organizations o ON o.id=t.organization_id WHERE t.origin=$1",
        [origin],
      )
    ).rows[0];
    if (!row) return null;
    if (!currentEntitlement(row))
      throw new PlatformError(
        402,
        "subscription",
        "This company requires subscription review. Open your company billing account.",
      );
    if (row.state !== "ready") {
      const setupAllowed =
        /^\/api\/(?:healthz|auth\/(?:options|session|login|logout|staff\/accept)|workspace-brand|platform\/tenant-probe)$/.test(
          path,
        ) || !path.startsWith("/api/");
      if (!setupAllowed)
        throw new PlatformError(
          503,
          "company_setup",
          "Complete company owner setup before using the workspace.",
        );
    }
    const databaseUrl = await vault.secret(
      vaultReference(row.database_secret_ref, config.vaultOrigin),
    );
    const expected = provisionedResources(
        { id: row.organization_id, slug: row.slug },
        config,
      ),
      parsed = new URL(databaseUrl);
    if (
      row.workspace_key !== expected.workspaceKey ||
      row.container !== expected.container ||
      row.database_secret_ref !== expected.databaseRef ||
      origin !== expected.origin ||
      parsed.hostname.toLowerCase() !== config.pgHost?.toLowerCase() ||
      parsed.pathname !== `/${expected.database}` ||
      decodeURIComponent(parsed.username) !== expected.role ||
      parsed.searchParams.get("sslmode") !== "verify-full" ||
      ["host", "hostaddr", "port", "database", "dbname", "service"].some(
        (key) => parsed.searchParams.has(key),
      ) ||
      row.configuration.azureStorageAccountUrl !== config.storageAccount
    )
      throw new PlatformError(
        503,
        "resource_binding",
        "Company resource configuration requires operator attention.",
      );
    return {
      key: row.workspace_key,
      host,
      origin,
      databaseUrl,
      poolMax: 2,
      environment: Object.freeze({
        APP_BASE_URL: origin,
        DEMO_MODE: "false",
        DEMO_ACCESS_ENABLED: "false",
        COMMS_DELIVERY_MODE: "capture",
        BACKGROUND_WORKERS_ENABLED: "true",
        AZURE_STORAGE_ACCOUNT_URL: row.configuration.azureStorageAccountUrl,
        AZURE_STORAGE_CONTAINER: row.container,
        IDENTITY_ENDPOINT: env.IDENTITY_ENDPOINT,
        IDENTITY_HEADER: env.IDENTITY_HEADER,
        OUTLOOK_REDIRECT_URI: `${origin}/api/calendar/outlook/callback`,
        QUICKBOOKS_REDIRECT_URI: `${origin}/api/quickbooks/callback`,
      }),
    };
  }
  async function failure(store, table, row, error) {
    const primary =
      table === "platform_provisioning_jobs" ? "organization_id" : "id";
    const terminal =
        row.attempts >= 8 ||
        (error instanceof PlatformError && error.status < 500),
      delay = Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7));
    await store.query(
      `UPDATE ${table} SET locked_until=NULL,error_code=$3,next_attempt_at=${terminal ? "'infinity'" : "now()+($4*interval '1 second')"}${table === "platform_provisioning_jobs" ? "" : `,state='${terminal ? "failed" : "pending"}'`} WHERE ${primary}=$1 AND lease_token=$2`,
      terminal
        ? [row[primary], row.lease_token, safeFailure(error)]
        : [row[primary], row.lease_token, safeFailure(error), delay],
    );
    if (table === "platform_provisioning_jobs")
      await store.query(
        "UPDATE platform_organizations SET state='failed',updated_at=now() WHERE id=$1 AND state<>'ready'",
        [row.organization_id],
      );
    log({ code: safeFailure(error), area: table });
  }
  async function billingTick() {
    if (
      readOnly ||
      billingRunning ||
      env.PLATFORM_BILLING_WORKER_ENABLED !== "true"
    )
      return;
    billingRunning = true;
    try {
      const { store, billing, mail } = await getServices();
      for (const table of ["platform_billing_events", "platform_email_outbox"])
        for (let i = 0; i < 4; i++) {
          const row = await store.claim(table);
          if (!row) break;
          try {
            if (table === "platform_billing_events") {
              await billing.processEvent(row);
              await store.query(
                "UPDATE platform_billing_events SET state='processed',processed_at=now(),locked_until=NULL,error_code=NULL WHERE id=$1 AND lease_token=$2",
                [row.id, row.lease_token],
              );
            } else await mail.send(row);
          } catch (error) {
            await failure(store, table, row, error);
          }
        }
      await store.query(
        "DELETE FROM platform_rate_limits WHERE expires_at<now()",
      );
      const stale = (
        await store.query(
          "SELECT stripe_subscription_id FROM platform_organizations WHERE stripe_subscription_id IS NOT NULL AND entitlement<>'grandfathered' AND (last_billing_sync IS NULL OR last_billing_sync<now()-interval '5 minutes') ORDER BY last_billing_sync NULLS FIRST LIMIT 10",
        )
      ).rows;
      for (const row of stale)
        try {
          await billing.applySubscription(row.stripe_subscription_id);
        } catch (error) {
          log({ code: safeFailure(error), area: "billing_reconciliation" });
        }
    } catch (error) {
      log({ code: safeFailure(error), area: "platform_worker" });
    } finally {
      billingRunning = false;
    }
  }
  function kick() {
    void billingTick();
  }
  function startBillingWorker() {
    if (
      !config.enabled ||
      readOnly ||
      env.PLATFORM_BILLING_WORKER_ENABLED !== "true" ||
      billingTimer
    )
      return;
    kick();
    billingTimer = setInterval(kick, 10_000);
    billingTimer.unref();
  }
  async function provisioningTick() {
    if (readOnly || provisioningRunning || !config.provisioningEnabled) return;
    provisioningRunning = true;
    try {
      const { store, provisioner } = await getServices();
      const row = await store.claim("platform_provisioning_jobs");
      if (row)
        try {
          await provisioner.process(row);
        } catch (error) {
          await failure(store, "platform_provisioning_jobs", row, error);
        }
    } catch (error) {
      log({ code: safeFailure(error), area: "platform_provisioner" });
    } finally {
      provisioningRunning = false;
    }
  }
  function startProvisioningWorker() {
    if (readOnly || !config.enabled || !config.provisioningEnabled)
      throw new PlatformError(
        503,
        "provisioning",
        "The provisioning worker is disabled.",
      );
    void provisioningTick();
    provisioningTimer = setInterval(() => void provisioningTick(), 30_000);
  }
  async function migrate() {
    if (readOnly)
      throw new PlatformError(
        503,
        "recovery",
        "Control-plane migrations are unavailable during recovery.",
      );
    const { pool } = await getServices({ allowUnmigrated: true });
    return migratePlatform(pool, migrationDirectory);
  }
  async function upgradeTenants() {
    if (readOnly || !config.provisioningEnabled)
      throw new PlatformError(
        503,
        "tenant_upgrade",
        "Tenant upgrades require the dedicated provisioning process.",
      );
    const { store, vault } = await getServices(),
      results = [];
    const rows = (
      await store.query(
        "SELECT t.*,o.slug FROM platform_tenants t JOIN platform_organizations o ON o.id=t.organization_id ORDER BY t.workspace_key",
      )
    ).rows;
    for (const row of rows) {
      try {
        const expected = provisionedResources(
          { id: row.organization_id, slug: row.slug },
          config,
        );
        if (
          row.origin !== expected.origin ||
          row.database_secret_ref !== expected.databaseRef ||
          row.workspace_key !== expected.workspaceKey
        )
          throw new PlatformError(
            503,
            "resource_binding",
            "Company database binding differs from its provisioned resources.",
          );
        const url = await vault.secret(
            vaultReference(row.database_secret_ref, config.vaultOrigin),
          ),
          parsed = new URL(url);
        if (
          parsed.hostname.toLowerCase() !== config.pgHost?.toLowerCase() ||
          parsed.pathname !== `/${expected.database}` ||
          decodeURIComponent(parsed.username) !== expected.role ||
          parsed.searchParams.get("sslmode") !== "verify-full" ||
          ["host", "hostaddr", "port", "database", "dbname", "service"].some(
            (key) => parsed.searchParams.has(key),
          )
        )
          throw new PlatformError(
            503,
            "resource_binding",
            "Company database binding differs from its provisioned resources.",
          );
        const version = await runtime.migrateTenant(url);
        await store.audit("company.schema_upgraded", {
          organizationId: row.organization_id,
          details: { version },
        });
        results.push({
          workspaceKey: row.workspace_key,
          status: "verified",
          version,
        });
      } catch (error) {
        results.push({
          workspaceKey: row.workspace_key,
          status: "failed",
          code: safeFailure(error),
        });
      }
    }
    return results;
  }
  async function close() {
    clearInterval(billingTimer);
    clearInterval(provisioningTimer);
    if (resources) await (await resources).pool.end();
  }
  const router = createPlatformRouter({
    express,
    config,
    getServices,
    readiness,
    probe,
    readOnly,
  });
  return {
    router,
    readiness,
    resolveTenant,
    startBillingWorker,
    startProvisioningWorker,
    migrate,
    upgradeTenants,
    close,
    billingTick,
    provisioningTick,
    getServices,
    enabled: config.enabled,
    origin: config.origin,
    legacyOrigin: config.legacyOrigin,
  };
}
