import { randomBytes } from "node:crypto";
import {
  PlatformError,
  tenantOrigin,
  vaultReference,
  currentEntitlement,
} from "./config.mjs";

const identifier = (value) => {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(value))
    throw new PlatformError(
      503,
      "resource_name",
      "Invalid provisioned database identifier.",
    );
  return `"${value}"`;
};
export function provisionedResources(organization, config) {
  const suffix = organization.id.replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(suffix))
    throw new PlatformError(503, "organization", "Invalid company identity.");
  return {
    database: `cw_${suffix}`,
    role: `cw_${suffix}`,
    workspaceKey: `t-${suffix}`,
    container: `cw-${suffix}`,
    databaseRef: `${config.vaultOrigin}/secrets/cw-${suffix}-database`,
    origin: tenantOrigin(organization.slug, config),
  };
}
export function createProvisioner({
  Client,
  config,
  vault,
  store,
  mail,
  runtime,
  request = fetch,
}) {
  async function organization(id) {
    const org = (
      await store.query(
        "SELECT o.*,a.email AS owner_email,a.name AS owner_name FROM platform_organizations o JOIN platform_accounts a ON a.id=o.owner_account_id WHERE o.id=$1",
        [id],
      )
    ).rows[0];
    if (!org || !currentEntitlement(org))
      throw new PlatformError(
        409,
        "entitlement",
        "Company activation awaits a valid subscription.",
      );
    return org;
  }
  async function credentials(resources) {
    vaultReference(resources.databaseRef, config.vaultOrigin);
    let url = await vault.secret(resources.databaseRef, true);
    if (!url) {
      const server = new URL(await vault.secret(config.refs.provisioner));
      if (server.hostname.toLowerCase() !== config.pgHost?.toLowerCase())
        throw new PlatformError(
          503,
          "provisioner_host",
          "Provisioner database host does not match the approved server.",
        );
      server.username = resources.role;
      server.password = randomBytes(40).toString("base64url");
      server.pathname = `/${resources.database}`;
      server.search = "";
      server.searchParams.set("sslmode", "verify-full");
      server.searchParams.set("uselibpqcompat", "true");
      url = server.href;
      await vault.put(resources.databaseRef, url);
    }
    const parsed = new URL(url);
    if (
      parsed.hostname.toLowerCase() !== config.pgHost?.toLowerCase() ||
      decodeURIComponent(parsed.username) !== resources.role ||
      parsed.pathname !== `/${resources.database}` ||
      !parsed.password
    )
      throw new PlatformError(
        503,
        "resource_binding",
        "Saved company credentials do not match their allocated resources.",
      );
    return url;
  }
  async function database(resources, url, client) {
    const role = (
      await client.query(
        "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1",
        [resources.role],
      )
    ).rows[0];
    if (role && (role.rolsuper || role.rolcreatedb || role.rolcreaterole))
      throw new PlatformError(
        503,
        "role_boundary",
        "The allocated database role has unexpected privileges.",
      );
    if (!role) {
      const password = decodeURIComponent(new URL(url).password);
      if (!/^[A-Za-z0-9_-]{40,}$/.test(password))
        throw new PlatformError(
          503,
          "credential",
          "Invalid generated company credential.",
        );
      await client.query(
        `CREATE ROLE ${identifier(resources.role)} WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
    }
    const existing = (
      await client.query(
        "SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1",
        [resources.database],
      )
    ).rows[0];
    if (existing && existing.owner !== resources.role)
      throw new PlatformError(
        503,
        "database_boundary",
        "The allocated database already belongs to another role.",
      );
    if (!existing)
      await client.query(
        `CREATE DATABASE ${identifier(resources.database)} OWNER ${identifier(resources.role)}`,
      );
    await client.query(
      `REVOKE ALL ON DATABASE ${identifier(resources.database)} FROM PUBLIC`,
    );
    await client.query(
      `GRANT CONNECT,TEMPORARY ON DATABASE ${identifier(resources.database)} TO ${identifier(resources.role)}`,
    );
    await runtime.migrateTenant(url);
  }
  async function blob(resources, organizationId) {
    const account = new URL(config.storageAccount);
    if (
      !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(
        account.origin,
      ) ||
      account.pathname !== "/"
    )
      throw new PlatformError(
        503,
        "storage",
        "Configure the approved private storage account.",
      );
    const address = `${account.origin}/${resources.container}?restype=container`;
    const headers = {
      Authorization: `Bearer ${await vault.access("https://storage.azure.com/")}`,
      "x-ms-version": "2023-11-03",
      "x-ms-date": new Date().toUTCString(),
      "x-ms-meta-catalyst-organization": organizationId,
    };
    const response = await request(address, {
      method: "PUT",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 409) {
      const existing = await request(address, {
        method: "HEAD",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (
        !existing.ok ||
        existing.headers.get("x-ms-meta-catalyst-organization") !==
          organizationId ||
        existing.headers.get("x-ms-blob-public-access")
      )
        throw new PlatformError(
          503,
          "storage_boundary",
          "The allocated storage container is not private company storage.",
        );
    } else if (!response.ok)
      throw new PlatformError(
        503,
        "storage",
        "The provisioning worker cannot create private company storage.",
      );
  }
  async function checkRouting(resources) {
    if (!config.tlsReady)
      throw new PlatformError(
        503,
        "tenant_tls",
        "Company hostname and TLS routing awaits operator verification.",
      );
    const response = await request(
      `${resources.origin}/api/platform/tenant-probe`,
      { redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok)
      throw new PlatformError(
        503,
        "tenant_routing",
        "The new company hostname is not routing to Catalyst Works.",
      );
    const result = await response.json();
    if (result.workspaceKey !== resources.workspaceKey)
      throw new PlatformError(
        503,
        "tenant_routing",
        "The new company hostname does not match its workspace binding.",
      );
  }
  async function assertLease(job, writer = store.pool) {
    const current = (
      await writer.query(
        "SELECT lease_token FROM platform_provisioning_jobs WHERE organization_id=$1",
        [job.organization_id],
      )
    ).rows[0];
    if (current?.lease_token !== job.lease_token)
      throw new PlatformError(
        409,
        "provisioning_lease",
        "The company setup lease changed.",
      );
  }
  async function processLocked(job, client) {
    if (!config.provisioningEnabled || !config.refs.provisioner)
      throw new PlatformError(
        503,
        "provisioning",
        "The company provisioning worker is disabled.",
      );
    const org = await organization(job.organization_id),
      resources = provisionedResources(org, config);
    await assertLease(job);
    const url = await credentials(resources);
    await database(resources, url, client);
    await organization(org.id);
    await assertLease(job);
    await blob(resources, org.id);
    await store.query(
      "INSERT INTO platform_tenants(organization_id,workspace_key,origin,database_secret_ref,container,configuration) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id) DO NOTHING",
      [
        org.id,
        resources.workspaceKey,
        resources.origin,
        resources.databaseRef,
        resources.container,
        {
          azureStorageAccountUrl: config.storageAccount,
          integrationConfiguration: "operator_required",
        },
      ],
    );
    await runtime.registerTenant({
      ...resources,
      databaseUrl: url,
      storageAccount: config.storageAccount,
    });
    await checkRouting(resources);
    await store.query(
      "UPDATE platform_tenants SET dns_tls_verified_at=now(),updated_at=now() WHERE organization_id=$1",
      [org.id],
    );
    const saved = job.resources ?? {};
    const activated = await runtime.ownerActivated(
      url,
      saved.ownerEmail ?? org.owner_email,
    );
    const queued = saved.ownerInviteMailId
      ? (
          await store.query(
            "SELECT expires_at,state FROM platform_email_outbox WHERE id=$1",
            [saved.ownerInviteMailId],
          )
        ).rows[0]
      : null;
    const invitationExpired =
      queued?.expires_at && new Date(queued.expires_at).getTime() <= Date.now();
    if (!activated && (!saved.ownerInviteMailId || invitationExpired)) {
      await assertLease(job);
      const invitation = await runtime.prepareOwner({
        ...resources,
        databaseUrl: url,
        storageAccount: config.storageAccount,
        company: org.company_name,
        name: org.owner_name,
        email: org.owner_email,
      });
      await store.transaction(async (writer) => {
        const current = (
          await writer.query(
            "SELECT entitlement,subscription_ends_at FROM platform_organizations WHERE id=$1 FOR UPDATE",
            [org.id],
          )
        ).rows[0];
        if (!currentEntitlement(current))
          throw new PlatformError(
            409,
            "entitlement",
            "Subscription changed while company setup was running.",
          );
        await assertLease(job, writer);
        const mailId = await mail.enqueue(
          writer,
          org.owner_account_id,
          org.owner_email,
          "Set up your Catalyst Works company password",
          `Your company workspace is ${resources.origin}.\n\nSet your password using this one-use link:\n${invitation.url}\n\nThe setup link expires ${invitation.expiresAt}. Your company activates after password setup and infrastructure verification.`,
          "owner_invitation",
          invitation.expiresAt,
        );
        await writer.query(
          "UPDATE platform_organizations SET state='owner_pending',updated_at=now() WHERE id=$1",
          [org.id],
        );
        await writer.query(
          "UPDATE platform_provisioning_jobs SET step='owner_pending',resources=$3,next_attempt_at=now()+interval '30 seconds',locked_until=NULL,error_code=NULL WHERE organization_id=$1 AND lease_token=$2",
          [
            org.id,
            job.lease_token,
            {
              ...resources,
              ownerInviteMailId: mailId,
              ownerEmail: org.owner_email,
            },
          ],
        );
      });
      return;
    }
    if (!activated) {
      await store.query(
        "UPDATE platform_provisioning_jobs SET next_attempt_at=now()+interval '60 seconds',locked_until=NULL WHERE organization_id=$1 AND lease_token=$2",
        [org.id, job.lease_token],
      );
      return;
    }
    await store.transaction(async (writer) => {
      const current = (
        await writer.query(
          "SELECT entitlement,subscription_ends_at FROM platform_organizations WHERE id=$1 FOR UPDATE",
          [org.id],
        )
      ).rows[0];
      if (!currentEntitlement(current))
        throw new PlatformError(
          409,
          "entitlement",
          "Company activation awaits billing review.",
        );
      await assertLease(job, writer);
      await writer.query(
        "UPDATE platform_tenants SET owner_activated_at=COALESCE(owner_activated_at,now()),ready_at=COALESCE(ready_at,now()),updated_at=now() WHERE organization_id=$1 AND dns_tls_verified_at IS NOT NULL",
        [org.id],
      );
      await writer.query(
        "UPDATE platform_organizations SET state='ready',updated_at=now() WHERE id=$1",
        [org.id],
      );
      await writer.query(
        "UPDATE platform_provisioning_jobs SET step='complete',next_attempt_at='infinity',locked_until=NULL,error_code=NULL WHERE organization_id=$1 AND lease_token=$2",
        [org.id, job.lease_token],
      );
      await store.audit(
        "company.activated",
        { organizationId: org.id },
        writer,
      );
    });
  }
  async function process(job) {
    if (!config.provisioningEnabled || !config.refs.provisioner)
      throw new PlatformError(
        503,
        "provisioning",
        "The company provisioning worker is disabled.",
      );
    const adminUrl = await vault.secret(config.refs.provisioner),
      approved = new URL(adminUrl);
    if (approved.hostname.toLowerCase() !== config.pgHost?.toLowerCase())
      throw new PlatformError(
        503,
        "provisioner_host",
        "Provisioner database host does not match the approved server.",
      );
    const client = new Client({
      connectionString: adminUrl,
      connectionTimeoutMillis: 8000,
      query_timeout: 30_000,
    });
    await client.connect();
    let heartbeat;
    try {
      const locked = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [job.organization_id],
      );
      if (!locked.rows[0]?.acquired)
        throw new PlatformError(
          503,
          "provisioning_lock",
          "This company is already being provisioned.",
        );
      heartbeat = setInterval(() => {
        void store
          .query(
            "UPDATE platform_provisioning_jobs SET locked_until=now()+interval '5 minutes' WHERE organization_id=$1 AND lease_token=$2",
            [job.organization_id, job.lease_token],
          )
          .catch(() => {});
      }, 30_000);
      heartbeat.unref();
      await processLocked(job, client);
    } finally {
      clearInterval(heartbeat);
      await client.end();
    }
  }
  return { process };
}
