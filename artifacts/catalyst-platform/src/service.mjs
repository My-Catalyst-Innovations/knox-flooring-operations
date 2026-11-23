import { randomUUID } from "node:crypto";
import {
  PlatformError,
  companyInput,
  tenantOrigin,
  validEmail,
} from "./config.mjs";

export function createService({ config, store, mail, billing }) {
  async function signup(input, ip) {
    if (config.blockers.length)
      throw new PlatformError(
        503,
        "readiness",
        "Company signup is waiting for approved pricing and platform configuration.",
      );
    const owner = companyInput(input);
    tenantOrigin(owner.slug, config);
    if (!config.liveMode && !config.testEmails?.includes(owner.email))
      throw new PlatformError(
        403,
        "internal_testing",
        "Company subscriptions are currently limited to approved internal test accounts.",
      );
    await store.rate("signup-ip", ip, 20);
    await store.rate("signup-email", owner.email, 3);
    await store.transaction(async (writer) => {
      const account = (
        await writer.query(
          "INSERT INTO platform_accounts(id,email,name) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *",
          [randomUUID(), owner.email, owner.name],
        )
      ).rows[0];
      await mail.accountLink(
        account,
        "verify",
        { company: owner.company, slug: owner.slug, termsUrl: config.termsUrl },
        writer,
      );
    });
    return {
      message:
        "Check your email to verify ownership and continue your company setup.",
    };
  }
  async function requestLogin(email, ip) {
    email = String(email ?? "")
      .trim()
      .toLowerCase();
    if (!validEmail(email))
      throw new PlatformError(400, "email", "Enter a valid account email.");
    await store.rate("login-ip", ip, 30);
    await store.rate("login-email", email, 3);
    const account = (
      await store.query(
        "SELECT * FROM platform_accounts WHERE email=$1 AND verified_at IS NOT NULL",
        [email],
      )
    ).rows[0];
    if (account)
      await store.transaction((writer) =>
        mail.accountLink(account, "login", {}, writer),
      );
    return {
      message:
        "If this address has a verified account, a sign-in link is on its way.",
    };
  }
  async function profile(account) {
    const organizations = (
      await store.query(
        "SELECT o.id,o.slug,o.company_name,o.profile,o.state,o.entitlement,o.subscription_status,o.subscription_ends_at,o.revision,t.origin,t.ready_at,t.owner_activated_at FROM platform_organizations o JOIN platform_memberships m ON m.organization_id=o.id LEFT JOIN platform_tenants t ON t.organization_id=o.id WHERE m.account_id=$1 ORDER BY o.created_at",
        [account.id],
      )
    ).rows;
    return {
      account: { id: account.id, name: account.name, email: account.email },
      csrfToken: account.csrf_token,
      organizations: organizations.map((o) => ({
        ...o,
        origin: o.state === "ready" ? o.origin : null,
        setupPending: o.state === "owner_pending",
        operatorConfigurationRequired: o.state === "failed",
      })),
    };
  }
  async function updateAccount(account, input) {
    const name = String(input?.name ?? "").trim(),
      email = String(input?.email ?? account.email)
        .trim()
        .toLowerCase();
    if (!name || name.length > 150 || !validEmail(email))
      throw new PlatformError(
        400,
        "profile",
        "Enter your name and a valid email.",
      );
    if (email !== account.email)
      await store.rate("email-change", account.id, 3);
    await store.transaction(async (writer) => {
      await writer.query(
        "UPDATE platform_accounts SET name=$2,updated_at=now() WHERE id=$1",
        [account.id, name],
      );
      if (email !== account.email)
        await mail.accountLink(account, "email_change", { email }, writer);
      await store.audit(
        "account.profile_updated",
        {
          accountId: account.id,
          details: { emailVerificationPending: email !== account.email },
        },
        writer,
      );
    });
    return {
      message:
        email !== account.email
          ? "Profile saved. Verify the new email before it replaces your account address."
          : "Profile saved.",
    };
  }
  async function updateCompany(account, organizationId, input) {
    const company = String(input?.companyName ?? "").trim(),
      phone = String(input?.phone ?? "").trim(),
      address = String(input?.address ?? "").trim();
    if (
      !company ||
      company.length > 150 ||
      phone.length > 40 ||
      address.length > 500 ||
      !Number.isSafeInteger(input?.revision)
    )
      throw new PlatformError(
        400,
        "profile",
        "Enter company name, contact details and the current profile version.",
      );
    const org = await store.organization(organizationId, account.id);
    const result = await store.query(
      "UPDATE platform_organizations SET company_name=$2,profile=profile||$3::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING id",
      [org.id, company, JSON.stringify({ phone, address }), input.revision],
    );
    if (!result.rows.length)
      throw new PlatformError(
        409,
        "revision",
        "The company profile changed. Refresh it before saving.",
      );
    await store.audit("company.profile_updated", {
      accountId: account.id,
      organizationId: org.id,
    });
    return { message: "Company profile saved." };
  }
  return {
    signup,
    requestLogin,
    profile,
    updateAccount,
    updateCompany,
    checkout: async (account, organizationId, planKey) =>
      billing.checkout(
        await store.organization(organizationId, account.id),
        account,
        planKey,
      ),
    portal: async (account, organizationId) =>
      billing.portal(await store.organization(organizationId, account.id)),
  };
}
