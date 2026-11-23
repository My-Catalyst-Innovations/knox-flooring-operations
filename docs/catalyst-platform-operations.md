# Catalyst Works company accounts and subscriptions

## Current release boundary

Company signup is implemented but **disabled by default**. It must not be advertised as available until the approved commercial terms, verified provider configuration, tenant infrastructure and release checks below are complete. No prices, setup fees, trial offer or legal policies are supplied by this release. Existing Knoxville Flooring accounts continue to use their existing database, authentication and connections independently of this feature.

The control website is `works.mycatalystinnovations.com`. A newly provisioned company uses `<company>.works.mycatalystinnovations.com`, its own PostgreSQL database and restricted database role, and its own private Blob container. Public registration never creates a user in the Knoxville database. Company billing accounts use a separate verified-email session; company staff use the existing workspace login and permissions.

New workspaces start with communication capture enabled and no Microsoft, QuickBooks or SMS provider credentials. Those integrations require operator setup and company consent. A central OAuth callback relay is not included; each configured workspace needs registered callback URLs and its own encrypted connection configuration. A ready subscription/workspace does not imply that those providers are connected.

## Separate stores and process identities

1. Create an empty **control-plane PostgreSQL database**, separate from every company ledger database. Store its `verify-full` TLS URL in the runtime Key Vault. Never supply the existing `DATABASE_URL` as the control-plane secret. The application refuses a control store containing tenant tables or the same database identity as the legacy company.
2. Use a runtime vault for control-store access, Stripe/Resend keys, outbox encryption and generated restricted tenant URLs. Use a **different, worker-only vault** for the PostgreSQL provisioning administrator URL. The HTTP managed identity must not have access to this privileged vault.
3. The HTTP identity needs runtime-vault secret reads and access to private containers in the dedicated Works storage account. The dedicated provisioning identity needs runtime-vault reads/writes, worker-vault reads, and container creation/access in that Works account. Grant access explicitly; the application never grants itself Azure roles. Keep unrelated storage accounts and vaults outside both identities' scope.
4. Run the provisioner as a dedicated process/identity, not inside the HTTP app. It alone reads the worker-only database administrator secret. Generated company roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`; public database access is revoked. Tenant runtime and migration connections use the restricted company URL, not the administrator URL.
5. Use the same persistent outbox encryption key across restarts. Keep secret values out of Git, browser configuration, support screenshots and command output. Configuration contains Key Vault references only. Preserve old encryption-key material during recovery; changing it without a controlled migration prevents queued links from being decrypted.

Control tables have their own immutable `platform_schema_migrations` ledger and SQL directory at `artifacts/catalyst-platform/migrations`. Company tables continue to use `lib/db` migrations. There are no HTTP-triggered migrations or automatic control-store seeding.

## Disabled configuration template

The complete names are in `.env.example`. Configure canonical HTTPS origins and Key Vault references, not copied secret values. `PLATFORM_ENABLED=false` preserves the existing single-company behavior. A partially configured enabled platform reports signup unavailable and must not prevent legitimate legacy-company access.

`PLATFORM_PLANS_JSON` is an array of approved server offers: `{ "key": "<offer-key>", "name": "<approved name>", "interval": "month" | "year", "priceId": "<Stripe recurring Price ID>" }`. Amounts and currency are retrieved from Stripe; the browser cannot submit a price or quantity. Do not invent amounts, publish a placeholder plan, or reuse a test Price for public live subscriptions. Trial days, tax mode, terms and privacy URLs require explicit owner approval before their readiness flags are enabled.

For test-mode Stripe, `PLATFORM_TEST_ACCOUNT_ALLOWLIST` must contain only explicitly approved internal email addresses. Signup, checkout and entitlement checks enforce this list. Public commercial activation requires live keys, live Prices, live webhook secrets and `PLATFORM_STRIPE_LIVE_MODE=true`; switching that flag alone cannot validate an incomplete setup.

## DNS and TLS before activation

Route `*.works.mycatalystinnovations.com` to the same application while preserving the original Host header. Configure the matching certificate and HTTPS binding. An existing `*.mycatalystinnovations.com` certificate does not cover the additional company label. Azure App Service free managed certificates do not support wildcard certificates; use an appropriate managed edge or supplied certificate and configure renewal. See [Azure TLS documentation](https://learn.microsoft.com/en-us/azure/app-service/overview-tls).

Set `PLATFORM_TENANT_TLS_READY=true` only after an actual nested company hostname has valid public DNS and TLS and reaches this app. Provisioning additionally probes each company's HTTPS endpoint and checks the returned workspace key. A hostname claim, Stripe success URL or database creation alone never marks a company ready. Reserve the root website and all statically configured company hosts; the registry rejects a collision.

## Stripe and account email

Create a hosted Checkout subscription integration using the approved recurring Prices. This release pins Stripe SDK 23.2.0 and webhook/API version `2026-11-18.endive`, uses flexible billing, and allows Stripe to choose eligible payment methods. Configure a Customer Portal with the approved cancellation and payment-update policy; use `PLATFORM_STRIPE_PORTAL_CONFIGURATION` when a particular portal configuration is required.

Configure the signed endpoint `https://works.mycatalystinnovations.com/api/platform/stripe/webhook` with these events:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`.
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`.
- `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalization_failed`.
- `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created`, `customer.updated`.

Use the matching mode's signing secret. Verification uses raw bytes before JSON parsing, deduplicates event IDs and refetches authoritative company-owned Stripe state under a company lock. Metadata and Checkout redirects cannot grant access. Existing owned contracts retain their approved Price when it is removed from new-sale offers; an unknown remote Price cannot become approved on a later reconciliation.

Choose `PLATFORM_TAX_MODE=stripe_tax` only after the business address, registrations and product/Price tax configuration have been reviewed and Stripe Tax is active. This mode sends `automatic_tax.enabled=true`. `approved_none` requires an explicit owner-approved decision and flag; it is not an inference from an empty registration list. The observed account tax settings at development time were pending with no head-office address or active registrations. The application does not create tax registrations.

Use a verified transactional Resend sender, with SPF/DKIM/DMARC configured for its domain. Enable signed delivery events at `https://works.mycatalystinnovations.com/api/platform/email/webhook` for `email.sent`, `email.delivered`, `email.failed`, `email.bounced`, `email.complained` and `email.suppressed`. Keep this platform webhook secret distinct from tenant email webhooks. Tokens are hash-only in the account store; encrypted outbox links expire after 30 minutes. Staff owner-setup links expire after 48 hours. Permanent bounces and complaints suppress further account email. Provider acceptance means submitted, not delivered.

## Initial setup and normal operation

Run from the deployed application root (`/app` in the release image), using the appropriate process identity and the same release artifact. SQL and migration-runner files must accompany the bundle.

```text
node artifacts/api-server/dist/platform-cli.mjs migrate
node artifacts/api-server/dist/platform-cli.mjs status
node artifacts/api-server/dist/platform-cli.mjs billing-worker
node artifacts/api-server/dist/platform-cli.mjs provisioner
```

`migrate` and `status` use the control-store role and have no default company-database fallback. The provisioner command sets its restricted process role before loading runtime modules. The HTTP app can process billing/email queues when `PLATFORM_BILLING_WORKER_ENABLED=true`; a separate billing worker is an alternative. Avoid redundant worker processes unless their connection budget has been counted. Durable leases and provider idempotency protect retries.

The lifecycle is verified owner email → company profile → hosted Checkout → verified billing entitlement → isolated resources/migrations → owner invitation → actual password activation → ready. Pending payment remains locked against duplicate Checkout subscriptions. Lost provider responses reuse the exact saved request and idempotency key; requests older than the safe idempotency window require operator reconciliation. Provisioning retries reuse deterministic UUID-bound resources and never delete a database to restart setup. A retry/status refresh must not invalidate a still-usable owner invitation.

The database budget defaults to 33 connections: legacy pool 10 + HTTP control pool 4 + eight lazy company pools of two + separate provisioner maximum 3 (one control connection, administrator and tenant connection). Static configured company pools also count against the aggregate cap. The verified Azure server limit was 50; recheck its actual setting before increasing limits or processes. Idle eviction never closes a leased pool. Background worker ticks acquire their own lease, so companies beyond the eight cached pools continue to receive service. Credential rotation retains database identity and replaces only idle pools.

## Release upgrades, backup and recovery

Before a release, back up the control store and every affected company database, record the source version and migration hashes, and prove restoration into an isolated environment. Control backups contain billing ownership, credential references and provisioning state; they do not replace company backups. Back up or retain the separate vault material and private blobs according to the approved retention policy.

Apply new control migrations with `migrate`, then run the dedicated provisioning identity's serial upgrade operation:

```text
node artifacts/api-server/dist/platform-cli.mjs upgrade-tenants
```

Every registry company is considered, including temporarily suspended subscriptions. The operation verifies UUID-bound host/database/role identity, runs the immutable tenant migration runner, audits success and returns failure for any incomplete company. Current code refuses dynamic company traffic and background jobs until its tenant schema and binding match the release; application HTTP never performs DDL. Fix an upgrade failure and rerun the operation before declaring that company available. Existing statically configured databases retain the release entrypoint migration checks.

During `READ_ONLY_RECOVERY=true`, all platform mutations, verification consumption, webhooks, outbox processing, provisioning and migrations are blocked. Registry lookup remains available for existing tenant read access. Keep prior source/recovery artifacts and verified backups available. Do not perform down-migrations, delete tenant resources or point the root company at a different database to roll back. Use the existing verified read-only recovery image while a compatible forward repair or tested restoration is prepared.

## Operational review and acceptance

Monitor readiness, failed queue counts, next-attempt timestamps, lease expiry, suppressed email and open risk reviews. Logs report safe error codes, not credentials or email-link tokens. Refunds, disputes and early fraud warnings put access into review; an unrelated active-subscription webhook cannot clear that hold. The release records the reason but does not issue refunds or provide an automatic risk override. Resolve the provider/business issue through an audited operator procedure before changing entitlements.

Before enabling public signup, verify: immutable migrations; existing Knoxville owner login and profile; unknown-host rejection; email verification and CSRF; signed webhook replay/out-of-order and customer ownership; frozen Checkout retry payloads; declined/unpaid/paused/trial-expired access; separately scoped Vault identities; isolated restricted database and private container; real owner activation; DNS/TLS; upgrade schema gate; recovery read-only behavior; delivery suppression; and approved live pricing/trial/tax/legal settings. Exercise billing first with allowlisted internal Stripe test accounts. Never use Will's real books for this test and never represent synthetic provider fixtures as live acceptance.
