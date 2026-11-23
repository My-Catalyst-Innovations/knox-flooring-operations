import { createHash, randomBytes } from "node:crypto";

export class PlatformError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const slugPattern = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const reservedSlugs = new Set([
  "www",
  "app",
  "api",
  "admin",
  "account",
  "billing",
  "signup",
  "support",
  "works",
  "knoxville",
  "catalyst",
  "platform",
  "status",
]);
export const eventTypes = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
  "charge.refunded",
  "charge.dispute.created",
  "radar.early_fraud_warning.created",
  "customer.updated",
]);
export function httpsOrigin(value, label) {
  try {
    const url = new URL(value);
    if (
      url.origin !== value ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password
    )
      throw Error();
    return url.origin;
  } catch {
    throw new PlatformError(
      503,
      "configuration",
      `${label} requires a canonical HTTPS origin.`,
    );
  }
}
export function vaultReference(value, vaultOrigin) {
  try {
    const url = new URL(value);
    if (
      url.origin !== vaultOrigin ||
      !/^\/secrets\/[a-zA-Z0-9-]{1,127}(?:\/[a-zA-Z0-9]+)?$/.test(
        url.pathname,
      ) ||
      url.search ||
      url.hash
    )
      throw Error();
    return url.href;
  } catch {
    throw new PlatformError(
      503,
      "secret_reference",
      "Configure an approved Key Vault secret reference.",
    );
  }
}
export function readPlatformConfig(env = process.env) {
  if (env.PLATFORM_ENABLED !== "true")
    return {
      enabled: false,
      blockers: ["Company signup is not enabled."],
      plans: [],
    };
  const origin = httpsOrigin(env.PLATFORM_ORIGIN, "Platform");
  const vaultOrigin = httpsOrigin(env.PLATFORM_KEY_VAULT_URL, "Key Vault");
  if (!/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net$/.test(vaultOrigin))
    throw new PlatformError(
      503,
      "configuration",
      "Configure an Azure Key Vault.",
    );
  const provisionerVaultOrigin = env.PLATFORM_PROVISIONER_KEY_VAULT_URL
    ? httpsOrigin(
        env.PLATFORM_PROVISIONER_KEY_VAULT_URL,
        "Provisioner Key Vault",
      )
    : null;
  if (
    provisionerVaultOrigin &&
    !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net$/.test(
      provisionerVaultOrigin,
    )
  )
    throw new PlatformError(
      503,
      "configuration",
      "Configure the separate provisioning Key Vault.",
    );
  const suffix = env.PLATFORM_TENANT_DOMAIN;
  if (
    !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(suffix ?? "") ||
    suffix.startsWith(".") ||
    suffix.includes("..")
  )
    throw new PlatformError(
      503,
      "configuration",
      "Configure the tenant domain.",
    );
  let plans;
  try {
    plans = JSON.parse(env.PLATFORM_PLANS_JSON ?? "[]");
  } catch {
    throw new PlatformError(
      503,
      "configuration",
      "Configure approved subscription plans.",
    );
  }
  if (
    !Array.isArray(plans) ||
    plans.some(
      (p) =>
        !p ||
        !/^[a-z][a-z0-9-]{1,40}$/.test(p.key ?? "") ||
        !/^price_[a-zA-Z0-9]+$/.test(p.priceId ?? "") ||
        typeof p.name !== "string" ||
        !p.name.trim() ||
        !["month", "year"].includes(p.interval),
    )
  )
    throw new PlatformError(
      503,
      "configuration",
      "Subscription plans require approved Price IDs, names, and billing intervals.",
    );
  if (
    new Set(plans.map((p) => p.key)).size !== plans.length ||
    new Set(plans.map((p) => p.priceId)).size !== plans.length
  )
    throw new PlatformError(
      503,
      "configuration",
      "Subscription plans must be unique.",
    );
  const trialDays = Number(env.PLATFORM_TRIAL_DAYS ?? 0);
  if (!Number.isSafeInteger(trialDays) || trialDays < 0 || trialDays > 90)
    throw new PlatformError(
      503,
      "configuration",
      "Configure the approved trial period.",
    );
  const refs = {};
  for (const [key, name] of Object.entries({
    database: "PLATFORM_DATABASE_URL_REF",
    stripe: "PLATFORM_STRIPE_KEY_REF",
    webhook: "PLATFORM_STRIPE_WEBHOOK_SECRET_REF",
    encryption: "PLATFORM_TOKEN_ENCRYPTION_KEY_REF",
    resend: "PLATFORM_RESEND_API_KEY_REF",
    emailWebhook: "PLATFORM_RESEND_WEBHOOK_SECRET_REF",
    provisioner: "PLATFORM_PROVISIONER_DATABASE_URL_REF",
  })) {
    refs[key] = env[name]
      ? vaultReference(
          env[name],
          key === "provisioner"
            ? (provisionerVaultOrigin ?? vaultOrigin)
            : vaultOrigin,
        )
      : null;
  }
  const blockers = [];
  if (!refs.database)
    blockers.push("Control-plane database is not configured.");
  if (!refs.stripe || !refs.webhook)
    blockers.push("Subscription billing is not connected.");
  if (!plans.length || env.PLATFORM_BILLING_POLICY_APPROVED !== "true")
    blockers.push("Subscription pricing and trial terms await approval.");
  if (env.PLATFORM_TAX_POLICY_APPROVED !== "true")
    blockers.push("Subscription tax treatment awaits review.");
  if (!["stripe_tax", "approved_none"].includes(env.PLATFORM_TAX_MODE))
    blockers.push("Choose the approved subscription tax collection mode.");
  if (
    !validHttpsUrl(env.PLATFORM_TERMS_URL) ||
    !validHttpsUrl(env.PLATFORM_PRIVACY_URL)
  )
    blockers.push("Published terms and privacy URLs are required.");
  if (
    !refs.resend ||
    !refs.emailWebhook ||
    !refs.encryption ||
    env.PLATFORM_EMAIL_ENABLED !== "true" ||
    !validEmail(env.PLATFORM_RESEND_FROM_EMAIL)
  )
    blockers.push("Verified account email delivery is not configured.");
  if (
    env.PLATFORM_PROVISIONING_ENABLED !== "true" ||
    !refs.provisioner ||
    !env.PLATFORM_TENANT_PG_HOST ||
    !env.PLATFORM_STORAGE_ACCOUNT_URL
  )
    blockers.push("Company provisioning is not configured.");
  if (!provisionerVaultOrigin || provisionerVaultOrigin === vaultOrigin)
    blockers.push(
      "Privileged provisioning credentials require a separate worker-only vault.",
    );
  if (env.PLATFORM_TENANT_TLS_READY !== "true")
    blockers.push("Company hostname and TLS routing awaits verification.");
  const testEmails = String(env.PLATFORM_TEST_ACCOUNT_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (env.PLATFORM_STRIPE_LIVE_MODE !== "true" && !testEmails.length)
    blockers.push(
      "Company subscriptions are restricted to approved internal test accounts.",
    );
  return {
    enabled: true,
    origin,
    vaultOrigin,
    provisionerVaultOrigin,
    suffix,
    plans: plans.map((p) => ({
      key: p.key,
      priceId: p.priceId,
      name: p.name,
      interval: p.interval,
    })),
    trialDays,
    refs,
    blockers,
    liveMode: env.PLATFORM_STRIPE_LIVE_MODE === "true",
    testEmails,
    policyApproved: env.PLATFORM_BILLING_POLICY_APPROVED === "true",
    taxApproved: env.PLATFORM_TAX_POLICY_APPROVED === "true",
    taxMode: env.PLATFORM_TAX_MODE,
    termsUrl: env.PLATFORM_TERMS_URL,
    privacyUrl: env.PLATFORM_PRIVACY_URL,
    emailEnabled: env.PLATFORM_EMAIL_ENABLED === "true",
    fromEmail: env.PLATFORM_RESEND_FROM_EMAIL,
    provisioningEnabled: env.PLATFORM_PROVISIONING_ENABLED === "true",
    tlsReady: env.PLATFORM_TENANT_TLS_READY === "true",
    pgHost: env.PLATFORM_TENANT_PG_HOST,
    storageAccount: env.PLATFORM_STORAGE_ACCOUNT_URL,
    processRole: env.PLATFORM_PROCESS_ROLE,
    legacyOrigin: env.APP_BASE_URL,
    legacyDatabase: env.DATABASE_URL,
    portalConfiguration: env.PLATFORM_STRIPE_PORTAL_CONFIGURATION || undefined,
  };
}
export function validEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
  );
}
export function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function companyInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new PlatformError(400, "input", "Enter your company details.");
  const name = String(input.name ?? "").trim(),
    email = String(input.email ?? "")
      .trim()
      .toLowerCase(),
    company = String(input.company ?? "").trim(),
    slug = String(input.slug ?? "")
      .trim()
      .toLowerCase();
  if (
    !name ||
    name.length > 150 ||
    !company ||
    company.length > 150 ||
    !validEmail(email) ||
    !slugPattern.test(slug) ||
    reservedSlugs.has(slug)
  )
    throw new PlatformError(
      400,
      "input",
      "Enter your name, a valid email, company name and available company address.",
    );
  if (input.acceptedTerms !== true)
    throw new PlatformError(
      400,
      "terms",
      "Accept the published company subscription terms before continuing.",
    );
  return { name, email, company, slug };
}
export function tenantOrigin(slug, config) {
  if (!slugPattern.test(slug) || reservedSlugs.has(slug))
    throw new PlatformError(400, "slug", "Choose another company address.");
  const origin = `https://${slug}.${config.suffix}`;
  if (
    origin === config.legacyOrigin ||
    config.reservedOrigins?.includes(origin)
  )
    throw new PlatformError(409, "slug", "This company address is reserved.");
  return origin;
}
export function billingEntitlement(subscription, allowedPriceIds, trialDays) {
  if (
    !subscription ||
    !Array.isArray(subscription.items?.data) ||
    subscription.items.data.length !== 1
  )
    return "none";
  const item = subscription.items.data[0];
  if (item.quantity !== 1 || !allowedPriceIds.has(item.price?.id))
    return "none";
  const invoice = subscription.latest_invoice;
  const id = (value) => (typeof value === "string" ? value : value?.id);
  if (
    subscription.status === "active" &&
    Number.isSafeInteger(item.current_period_end) &&
    item.current_period_end > Date.now() / 1000 &&
    invoice &&
    typeof invoice === "object" &&
    invoice.status === "paid" &&
    invoice.amount_remaining === 0 &&
    invoice.parent?.type === "subscription_details" &&
    id(invoice.parent.subscription_details?.subscription) === subscription.id &&
    id(invoice.customer) === id(subscription.customer)
  )
    return "paid";
  if (
    subscription.status === "trialing" &&
    trialDays > 0 &&
    Number.isSafeInteger(subscription.trial_start) &&
    Number.isSafeInteger(subscription.trial_end) &&
    subscription.trial_end > Date.now() / 1000 &&
    subscription.trial_end > subscription.trial_start &&
    subscription.trial_end - subscription.trial_start <= trialDays * 86400 + 60
  )
    return "trial";
  return "none";
}
export function currentEntitlement(organization, now = Date.now()) {
  return (
    organization?.entitlement === "grandfathered" ||
    (["paid", "trial"].includes(organization?.entitlement) &&
      new Date(organization.subscription_ends_at).getTime() > now)
  );
}
export function resourceReference(object) {
  const id = (value) =>
    typeof value === "string"
      ? value
      : typeof value?.id === "string"
        ? value.id
        : null;
  return {
    id: id(object),
    object: object?.object ?? null,
    customer: id(object?.customer),
    charge: id(object?.charge),
    paymentIntent: id(object?.payment_intent),
  };
}
export function safeFailure(error) {
  return error instanceof PlatformError ? error.code : "provider_unavailable";
}
