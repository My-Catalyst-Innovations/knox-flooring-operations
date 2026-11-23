import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPlatformConfig, currentEntitlement } from "../src/config.mjs";
import {
  createStore,
  migratePlatform,
  openPlatformPool,
} from "../src/store.mjs";
import { createBilling } from "../src/billing.mjs";
import { createPlatformMail } from "../src/email.mjs";
import { createService } from "../src/service.mjs";
import { createPlatformRouter, platformCookie } from "../src/router.mjs";
import {
  createProvisioner,
  provisionedResources,
} from "../src/provisioning.mjs";
import { createPlatform } from "../src/index.mjs";
import { unseal } from "../src/vault.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const apiBuild =
  process.env.CATALYST_ISOLATED_TEST === "true" ? "dist-test" : "dist";
const apiRequire = createRequire(path.join(root, "api-server/package.json"));
const dbRequire = createRequire(path.join(root, "../lib/db/package.json"));
const express = apiRequire("express"),
  StripeSdk = apiRequire("stripe"),
  { Pool, Client } = dbRequire("pg");
const source = process.env.TEST_DATABASE_URL;
const migrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const runFile = promisify(execFile);
const cleanEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(
        key,
      ),
    ),
  );
function localUrl(value) {
  const parsed = new URL(value);
  assert.ok(
    ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname),
    "Tests refuse a non-loopback PostgreSQL server.",
  );
  for (const key of ["sslmode", "uselibpqcompat"])
    parsed.searchParams.delete(key);
  return parsed.href;
}
function httpCall(address, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(address);
  assert.equal(url.hostname, "127.0.0.1");
  const encoded = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(encoded ? { "Content-Length": Buffer.byteLength(encoded) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode,
              body: raw ? JSON.parse(raw) : null,
              cookie: res.headers["set-cookie"]?.[0] ?? null,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(Error("Fixture HTTP timeout")));
    if (encoded) req.write(encoded);
    req.end();
  });
}

test(
  "real PostgreSQL platform HTTP, billing ownership and isolated provisioning",
  { skip: !source, timeout: 180_000 },
  async (t) => {
    const admin = new Client({ connectionString: localUrl(source) });
    await admin.connect();
    const dbName = `catalyst_platform_${process.pid}_${randomBytes(5).toString("hex")}`;
    assert.match(dbName, /^catalyst_platform_\d+_[a-f0-9]+$/);
    const controlUrl = new URL(localUrl(source));
    controlUrl.pathname = `/${dbName}`;
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const pool = new Pool({ connectionString: controlUrl.href, max: 4 });
    const store = createStore(pool),
      key = Buffer.alloc(32, 7).toString("base64");
    const vaultValues = new Map();
    const config = readPlatformConfig({
      PLATFORM_ENABLED: "true",
      PLATFORM_ORIGIN: "https://works.example.test",
      PLATFORM_KEY_VAULT_URL: "https://fixture.vault.azure.net",
      PLATFORM_PROVISIONER_KEY_VAULT_URL:
        "https://workerfixture.vault.azure.net",
      PLATFORM_TENANT_DOMAIN: "works.example.test",
      PLATFORM_DATABASE_URL_REF:
        "https://fixture.vault.azure.net/secrets/control",
      PLATFORM_STRIPE_KEY_REF: "https://fixture.vault.azure.net/secrets/stripe",
      PLATFORM_STRIPE_WEBHOOK_SECRET_REF:
        "https://fixture.vault.azure.net/secrets/stripe-hook",
      PLATFORM_TOKEN_ENCRYPTION_KEY_REF:
        "https://fixture.vault.azure.net/secrets/crypto",
      PLATFORM_RESEND_API_KEY_REF:
        "https://fixture.vault.azure.net/secrets/email",
      PLATFORM_RESEND_WEBHOOK_SECRET_REF:
        "https://fixture.vault.azure.net/secrets/email-hook",
      PLATFORM_PROVISIONER_DATABASE_URL_REF:
        "https://workerfixture.vault.azure.net/secrets/admin",
      PLATFORM_PLANS_JSON: JSON.stringify([
        {
          key: "fixture-monthly",
          name: "Internal test plan",
          interval: "month",
          priceId: "price_fixture",
        },
      ]),
      PLATFORM_BILLING_POLICY_APPROVED: "true",
      PLATFORM_TAX_POLICY_APPROVED: "true",
      PLATFORM_TAX_MODE: "approved_none",
      PLATFORM_TERMS_URL: "https://works.example.test/terms",
      PLATFORM_PRIVACY_URL: "https://works.example.test/privacy",
      PLATFORM_EMAIL_ENABLED: "true",
      PLATFORM_RESEND_FROM_EMAIL: "accounts@example.test",
      PLATFORM_PROVISIONING_ENABLED: "true",
      PLATFORM_TENANT_PG_HOST: "127.0.0.1",
      PLATFORM_STORAGE_ACCOUNT_URL:
        "https://fixturestorage.blob.core.windows.net",
      PLATFORM_TENANT_TLS_READY: "true",
      PLATFORM_TEST_ACCOUNT_ALLOWLIST: "owner@platform.test",
    });
    const hookSecret = "whsec_platform_synthetic_test_only";
    vaultValues.set(config.refs.database, controlUrl.href);
    vaultValues.set(config.refs.stripe, "rk_test_synthetic_fixture");
    vaultValues.set(config.refs.webhook, hookSecret);
    vaultValues.set(config.refs.encryption, key);
    vaultValues.set(config.refs.resend, "synthetic-fixture-key");
    vaultValues.set(
      config.refs.emailWebhook,
      "whsec_" + Buffer.alloc(32, 9).toString("base64"),
    );
    vaultValues.set(config.refs.provisioner, localUrl(source));
    const vault = {
      secret: async (ref, optional = false) => {
        if (vaultValues.has(ref)) return vaultValues.get(ref);
        if (optional) return null;
        throw Error("Unknown fixture reference");
      },
      put: async (ref, value) => {
        vaultValues.set(ref, value);
      },
      access: async () => "synthetic-managed-token",
    };
    const providerState = {
      session: null,
      subscription: null,
      createCalls: 0,
      checkoutParams: null,
      failOnce: false,
      requestKeys: [],
    };
    const realSdk = new StripeSdk("rk_test_synthetic_fixture", {
      apiVersion: "2026-11-18.endive",
    });
    const provider = {
      webhooks: realSdk.webhooks,
      prices: {
        retrieve: async () => ({
          id: "price_fixture",
          active: true,
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: 100,
          currency: "usd",
          livemode: false,
          recurring: {
            interval: "month",
            interval_count: 1,
            usage_type: "licensed",
          },
        }),
      },
      customers: {
        create: async () => ({ id: "cus_platform_fixture" }),
        retrieve: async (id) => ({
          id,
          email: "owner@platform.test",
          name: "Fixture customer",
        }),
      },
      checkout: {
        sessions: {
          create: async (params, options) => {
            providerState.createCalls++;
            providerState.checkoutParams = params;
            providerState.requestKeys.push(options.idempotencyKey);
            providerState.session = {
              id: "cs_platform_fixture",
              status: "open",
              mode: "subscription",
              livemode: false,
              customer: params.customer,
              client_reference_id: params.client_reference_id,
              url: "https://checkout.stripe.com/c/pay/synthetic-fixture",
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              payment_status: "unpaid",
              subscription: "sub_platform_fixture",
            };
            if (providerState.failOnce) {
              providerState.failOnce = false;
              throw Error("Synthetic lost checkout response");
            }
            return providerState.session;
          },
          retrieve: async () => providerState.session,
        },
      },
      subscriptions: {
        retrieve: async () => structuredClone(providerState.subscription),
      },
      billingPortal: {
        sessions: {
          create: async () => ({
            url: "https://billing.stripe.com/p/session/synthetic-fixture",
          }),
        },
      },
      charges: {
        retrieve: async () => ({
          id: "ch_fixture",
          customer: "cus_platform_fixture",
          payment_intent: "pi_fixture",
        }),
      },
      invoicePayments: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            yield { invoice: "in_fixture" };
          },
        }),
      },
      invoices: {
        retrieve: async () => ({
          id: "in_fixture",
          parent: {
            type: "subscription_details",
            subscription_details: { subscription: "sub_platform_fixture" },
          },
        }),
      },
    };
    function FakeStripe() {
      return provider;
    }
    const billing = createBilling({ Stripe: FakeStripe, config, vault, store });
    const mail = createPlatformMail({
      config,
      vault,
      store,
      request: async () => {
        throw Error("No actual email may leave this test.");
      },
    });
    const service = createService({ config, store, mail, billing });
    const services = { store, mail, billing, service, kick: () => {} };
    const app = express();
    app.set("trust proxy", false);
    app.use(
      "/api/platform",
      createPlatformRouter({
        express,
        config,
        getServices: async () => services,
        readiness: async () => ({
          enabled: true,
          signupAvailable: true,
          blockers: [],
        }),
        probe: async () => ({ workspaceKey: "fixture" }),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/api/platform`;
    const request = async (
      route,
      { method = "GET", body, cookie, csrf, headers = {} } = {},
    ) => {
      return httpCall(base + route, {
        method,
        headers: {
          Host: "works.example.test",
          Origin: config.origin,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { "x-platform-csrf": csrf } : {}),
          ...headers,
        },
        body,
      });
    };
    let organizationId, account, cookie, csrf, resources, child;
    try {
      await t.test(
        "versioned control-plane migrations are immutable and separate from tenant schema",
        async () => {
          assert.equal(
            await migratePlatform(pool, migrationDirectory),
            "0001_control_plane.sql",
          );
          assert.equal(
            await migratePlatform(pool, migrationDirectory, {
              checkOnly: true,
            }),
            "0001_control_plane.sql",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT to_regclass('public.users') AS tenant_users",
              )
            ).rows[0].tenant_users,
            null,
          );
          const forbidden = { ...config, legacyDatabase: controlUrl.href };
          await assert.rejects(
            openPlatformPool(Pool, forbidden, vault),
            /existing company database/,
          );
        },
      );
      await t.test(
        "verified email owns the new company and CSRF protects billing independently of tenant login",
        async () => {
          const denied = await request("/signup", {
            method: "POST",
            body: {
              name: "Public",
              email: "public@platform.test",
              company: "Public company",
              slug: "public-company",
              acceptedTerms: true,
            },
          });
          assert.equal(denied.status, 403);
          assert.equal(
            (
              await request("/signup", {
                method: "POST",
                body: {
                  name: "Owner",
                  email: "owner@platform.test",
                  company: "Indigo Flooring Test",
                  slug: "indigo-flooring-test",
                  acceptedTerms: true,
                  role: "platform_admin",
                  databaseUrl: "postgres://forged",
                },
              })
            ).status,
            202,
          );
          assert.equal(
            (await pool.query("SELECT count(*) FROM platform_organizations"))
              .rows[0].count,
            "0",
          );
          const queued = (
            await pool.query(
              "SELECT * FROM platform_email_outbox WHERE purpose='verify'",
            )
          ).rows[0];
          assert.ok(!queued.encrypted_payload.includes("owner@platform.test"));
          const message = unseal(queued.encrypted_payload, key),
            raw = /token=([A-Za-z0-9_-]{43})/.exec(message.text)[1];
          assert.notEqual(
            (await pool.query("SELECT token_hash FROM platform_tokens")).rows[0]
              .token_hash,
            raw,
          );
          const verified = await request("/auth/verify", {
            method: "POST",
            body: { token: raw },
          });
          assert.equal(verified.status, 200);
          assert.match(verified.cookie, new RegExp(`^${platformCookie}=`));
          assert.match(verified.cookie, /HttpOnly/);
          assert.doesNotMatch(verified.cookie, /Domain=/i);
          organizationId = verified.body.organizationId;
          csrf = verified.body.csrfToken;
          cookie = verified.cookie.split(";")[0];
          assert.equal(
            (
              await request("/auth/verify", {
                method: "POST",
                body: { token: raw },
              })
            ).status,
            400,
          );
          const current = await request("/account", { cookie });
          assert.equal(current.status, 200);
          assert.equal(current.body.organizations[0].id, organizationId);
          account = await store.session(cookie.split("=")[1]);
          assert.equal(
            (
              await request(`/organizations/${organizationId}/checkout`, {
                method: "POST",
                cookie,
                body: { planKey: "fixture-monthly" },
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "server-owned checkout never grants service from a success URL and blocks duplicate pending payment",
        async () => {
          providerState.failOnce = true;
          const lost = await request(
            `/organizations/${organizationId}/checkout`,
            {
              method: "POST",
              cookie,
              csrf,
              body: {
                planKey: "fixture-monthly",
                priceId: "price_forged",
                quantity: 999,
              },
            },
          );
          assert.equal(lost.status, 503);
          const original = structuredClone(providerState.checkoutParams);
          config.trialDays = 7;
          await pool.query(
            "UPDATE platform_organizations SET company_name=$2 WHERE id=$1",
            [organizationId, "Renamed internal fixture"],
          );
          const result = await request(
            `/organizations/${organizationId}/checkout`,
            {
              method: "POST",
              cookie,
              csrf,
              body: { planKey: "fixture-monthly" },
            },
          );
          config.trialDays = 0;
          assert.equal(result.status, 200);
          assert.equal(providerState.createCalls, 2);
          assert.deepEqual(providerState.checkoutParams, original);
          assert.equal(new Set(providerState.requestKeys).size, 1);
          assert.deepEqual(providerState.checkoutParams.line_items, [
            { price: "price_fixture", quantity: 1 },
          ]);
          assert.equal(
            providerState.checkoutParams.payment_method_types,
            undefined,
          );
          assert.equal(
            providerState.checkoutParams.subscription_data.billing_mode.type,
            "flexible",
          );
          assert.equal(
            (await store.organization(organizationId, account.id)).entitlement,
            "none",
          );
          providerState.session.status = "complete";
          assert.equal(
            (
              await request(`/organizations/${organizationId}/checkout`, {
                method: "POST",
                cookie,
                csrf,
                body: { planKey: "fixture-monthly" },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await request(`/organizations/${organizationId}/checkout`, {
                method: "POST",
                cookie,
                csrf,
                body: { planKey: "fixture-monthly" },
              })
            ).status,
            409,
          );
          assert.equal(providerState.createCalls, 2);
          assert.equal(
            (await store.organization(organizationId, account.id)).entitlement,
            "none",
          );
        },
      );
      async function deliver(type, object, eventId) {
        const event = {
            id: eventId,
            object: "event",
            type,
            livemode: false,
            api_version: "2026-11-18.endive",
            data: { object },
          },
          raw = JSON.stringify(event),
          signature = realSdk.webhooks.generateTestHeaderString({
            payload: raw,
            secret: hookSecret,
          });
        await billing.webhook(Buffer.from(raw), signature);
        const row = (
          await pool.query(
            "SELECT * FROM platform_billing_events WHERE id=$1",
            [eventId],
          )
        ).rows[0];
        await billing.processEvent(row);
        return row;
      }
      await t.test(
        "signed events use current Stripe ownership, ignore forged metadata, and deduplicate activation",
        async () => {
          await assert.rejects(
            billing.webhook(Buffer.from("{}"), "forged"),
            /signature/,
          );
          providerState.subscription = {
            id: "sub_platform_fixture",
            customer: "cus_platform_fixture",
            livemode: false,
            status: "active",
            items: {
              data: [
                {
                  quantity: 1,
                  price: { id: "price_fixture" },
                  current_period_end:
                    Math.floor(Date.now() / 1000) + 30 * 86400,
                },
              ],
            },
            latest_invoice: {
              status: "paid",
              amount_remaining: 0,
              customer: "cus_platform_fixture",
              parent: {
                type: "subscription_details",
                subscription_details: { subscription: "sub_platform_fixture" },
              },
            },
          };
          providerState.session.payment_status = "paid";
          const object = {
            id: "cs_platform_fixture",
            object: "checkout.session",
            customer: "cus_forged",
            metadata: { organization_id: "forged" },
          };
          await deliver(
            "checkout.session.completed",
            object,
            "evt_activation_fixture",
          );
          await deliver(
            "checkout.session.completed",
            object,
            "evt_activation_fixture",
          );
          const org = await store.organization(organizationId, account.id);
          assert.equal(org.entitlement, "paid");
          assert.equal(org.state, "provisioning");
          assert.equal(org.stripe_customer_id, "cus_platform_fixture");
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM platform_provisioning_jobs",
              )
            ).rows[0].count,
            "1",
          );
          assert.equal(
            (await pool.query("SELECT count(*) FROM platform_billing_events"))
              .rows[0].count,
            "1",
          );
          providerState.subscription.status = "canceled";
          await deliver(
            "customer.subscription.updated",
            {
              id: "sub_platform_fixture",
              object: "subscription",
              status: "active",
            },
            "evt_stale_active",
          );
          assert.equal(
            (await store.organization(organizationId, account.id)).entitlement,
            "none",
          );
          providerState.subscription.status = "active";
          await billing.applySubscription("sub_platform_fixture");
          assert.equal(
            (await store.organization(organizationId, account.id)).entitlement,
            "paid",
          );
          config.plans = [];
          await billing.applySubscription("sub_platform_fixture");
          assert.equal(
            (await store.organization(organizationId, account.id)).entitlement,
            "paid",
            "Archived public prices must retain an owned contract",
          );
          config.plans = [
            {
              key: "fixture-monthly",
              name: "Internal test plan",
              interval: "month",
              priceId: "price_fixture",
            },
          ];
          providerState.subscription.items.data[0].price.id =
            "price_unapproved";
          for (let i = 0; i < 2; i++) {
            await billing.applySubscription("sub_platform_fixture");
            assert.equal(
              (await store.organization(organizationId, account.id))
                .entitlement,
              "none",
              "An observed unapproved Price can never become an approved contract",
            );
          }
          providerState.subscription.items.data[0].price.id = "price_fixture";
          await billing.applySubscription("sub_platform_fixture");
        },
      );
      await t.test(
        "provisioning creates an isolated restricted-role database and activates only after actual password setup",
        async () => {
          class LocalClient extends Client {
            constructor(options) {
              super({
                ...options,
                connectionString: localUrl(options.connectionString),
              });
            }
          }
          let registered,
            ownerInvitations = 0,
            containerCreated = false;
          const runtime = {
            registerTenant: async (value) => {
              registered = value;
            },
            migrateTenant: async (value) => {
              const client = new LocalClient({ connectionString: value });
              await client.connect();
              try {
                const runner = await import(
                  pathToFileURL(
                    path.join(root, "../lib/db/scripts/migration-runner.mjs"),
                  ).href
                );
                await runner.runMigrations(client, {
                  migrations: await runner.loadMigrations(),
                  expectedColumns: await runner.loadExpectedColumns(),
                  expectedForeignKeys: await runner.loadExpectedForeignKeys(),
                });
              } finally {
                await client.end();
              }
            },
            prepareOwner: async (value) => {
              ownerInvitations++;
              const prefix = `CATALYST_${value.workspaceKey.toUpperCase().replaceAll("-", "_")}_`;
              const response = await runFile(
                process.execPath,
                [
                  path.join(
                    root,
                    `api-server/${apiBuild}/provision-workspace.mjs`,
                  ),
                  "--workspace",
                  value.workspaceKey,
                  "--company",
                  value.company,
                  "--owner-name",
                  value.name,
                  "--owner-email",
                  value.email,
                ],
                {
                  cwd: path.join(root, ".."),
                  env: {
                    ...cleanEnvironment(),
                    DATABASE_URL: localUrl(value.databaseUrl),
                    CATALYST_ISOLATED_TEST:
                      process.env.CATALYST_ISOLATED_TEST ?? "false",
                    CATALYST_WORKSPACES: JSON.stringify([
                      { key: value.workspaceKey, origin: value.origin },
                    ]),
                    [`${prefix}DATABASE_URL`]: localUrl(value.databaseUrl),
                  },
                },
              );
              const invitation = JSON.parse(
                response.stdout.trim().split(/\r?\n/).at(-1),
              );
              return {
                url: invitation.invitationUrl,
                expiresAt: invitation.expiresAt,
              };
            },
            ownerActivated: async (value, email) => {
              const client = new LocalClient({ connectionString: value });
              await client.connect();
              try {
                return !!(
                  await client.query(
                    "SELECT id FROM users WHERE email=$1 AND role='owner' AND active=true",
                    [email],
                  )
                ).rows.length;
              } finally {
                await client.end();
              }
            },
          };
          const provisioner = createProvisioner({
            Client: LocalClient,
            config,
            vault,
            store,
            mail,
            runtime,
            request: async (url, options) => {
              if (String(url).includes("/api/platform/tenant-probe"))
                return Response.json({ workspaceKey: registered.workspaceKey });
              if (options.method === "HEAD")
                return new Response(null, {
                  status: 200,
                  headers: {
                    "x-ms-meta-catalyst-organization": organizationId,
                  },
                });
              if (containerCreated) return new Response(null, { status: 409 });
              containerCreated = true;
              return new Response(null, { status: 201 });
            },
          });
          resources = provisionedResources(
            await store.organization(organizationId, account.id),
            config,
          );
          let job = await store.claim("platform_provisioning_jobs");
          assert.ok(job);
          await provisioner.process(job);
          let org = await store.organization(organizationId, account.id);
          assert.equal(org.state, "owner_pending");
          resources = provisionedResources(org, config);
          const tenant = (
            await pool.query(
              "SELECT * FROM platform_tenants WHERE organization_id=$1",
              [organizationId],
            )
          ).rows[0];
          assert.equal(tenant.ready_at, null);
          assert.ok(tenant.dns_tls_verified_at);
          assert.equal(tenant.database_secret_ref, resources.databaseRef);
          assert.ok(!JSON.stringify(tenant).includes("postgres://"));
          const role = (
            await admin.query(
              "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1",
              [resources.role],
            )
          ).rows[0];
          assert.deepEqual(role, {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
          });
          const inviteMail = (
              await pool.query(
                "SELECT * FROM platform_email_outbox WHERE purpose='owner_invitation'",
              )
            ).rows[0],
            invite = /invite=([A-Za-z0-9_-]{43})/.exec(
              unseal(inviteMail.encrypted_payload, key).text,
            )[1];
          const tenantUrl = localUrl(vaultValues.get(resources.databaseRef));
          child = spawn(
            process.execPath,
            [path.join(root, `api-server/${apiBuild}/index.mjs`)],
            {
              cwd: path.join(root, ".."),
              windowsHide: true,
              env: {
                ...cleanEnvironment(),
                DATABASE_URL: tenantUrl,
                PORT: "55976",
                HOST: "127.0.0.1",
                NODE_ENV: "test",
                APP_BASE_URL: resources.origin,
                CATALYST_ISOLATED_TEST:
                  process.env.CATALYST_ISOLATED_TEST ?? "false",
                BACKGROUND_WORKERS_ENABLED: "false",
                DEMO_MODE: "false",
                DEMO_ACCESS_ENABLED: "false",
                PLATFORM_ENABLED: "true",
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let error = "";
          child.stderr.on("data", (value) => {
            error = (error + value).slice(-1200);
          });
          let healthy = false;
          for (let i = 0; i < 100; i++) {
            try {
              healthy =
                (
                  await httpCall("http://127.0.0.1:55976/api/healthz", {
                    headers: { Host: new URL(resources.origin).host },
                  })
                ).status === 200;
            } catch {}
            if (healthy || child.exitCode !== null) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.ok(
            healthy,
            error.replace(/postgres(?:ql)?:\/\/\S+/g, "[fixture-database]"),
          );
          const accepted = await httpCall(
            "http://127.0.0.1:55976/api/auth/staff/accept",
            {
              method: "POST",
              headers: {
                Host: new URL(resources.origin).host,
                "Content-Type": "application/json",
                Origin: resources.origin,
              },
              body: {
                token: invite,
                password: "Synthetic-platform-owner-password",
              },
            },
          );
          assert.equal(accepted.status, 204);
          const blocked = await httpCall("http://127.0.0.1:55976/api/jobs", {
            headers: { Host: "unknown.example.test" },
          });
          assert.equal(
            blocked.status,
            503,
            "Unavailable platform configuration rejects unknown hosts without falling back to an existing tenant database",
          );
          const existing = await httpCall(
            "http://127.0.0.1:55976/api/auth/login",
            {
              method: "POST",
              headers: {
                Host: new URL(resources.origin).host,
                "Content-Type": "application/json",
              },
              body: {
                email: "owner@platform.test",
                password: "Synthetic-platform-owner-password",
              },
            },
          );
          assert.equal(
            existing.status,
            200,
            "Feature misconfiguration preserves legitimate existing tenant login",
          );
          child.kill();
          await once(child, "exit");
          child = null;
          await pool.query(
            "UPDATE platform_provisioning_jobs SET next_attempt_at=now() WHERE organization_id=$1",
            [organizationId],
          );
          job = await store.claim("platform_provisioning_jobs");
          await provisioner.process(job);
          org = await store.organization(organizationId, account.id);
          assert.equal(org.state, "ready");
          assert.equal(
            ownerInvitations,
            1,
            "Activating an existing owner must not mint another invitation",
          );
          assert.ok(
            (
              await pool.query(
                "SELECT ready_at FROM platform_tenants WHERE organization_id=$1",
                [organizationId],
              )
            ).rows[0].ready_at,
          );
        },
      );
      await t.test(
        "refund risk holds the customer and cannot be cleared by an unrelated active webhook",
        async () => {
          await deliver(
            "charge.refunded",
            { id: "ch_fixture", object: "charge" },
            "evt_refund_fixture",
          );
          assert.equal(
            (await store.organization(organizationId, account.id)).entitlement,
            "risk_review",
          );
          await billing.applySubscription("sub_platform_fixture");
          assert.equal(
            (await store.organization(organizationId, account.id)).entitlement,
            "risk_review",
          );
          assert.equal(
            currentEntitlement({
              entitlement: "paid",
              subscription_ends_at: new Date(Date.now() - 1000),
            }),
            false,
          );
          assert.equal(
            currentEntitlement({ entitlement: "grandfathered" }),
            true,
          );
        },
      );
    } finally {
      if (child) {
        child.kill();
        await once(child, "exit");
      }
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
      if (resources) {
        assert.match(resources.database, /^cw_[a-f0-9]{32}$/);
        assert.match(resources.role, /^cw_[a-f0-9]{32}$/);
        await admin.query(
          `DROP DATABASE IF EXISTS "${resources.database}" WITH (FORCE)`,
        );
        await admin.query(`DROP ROLE IF EXISTS "${resources.role}"`);
      }
      await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
