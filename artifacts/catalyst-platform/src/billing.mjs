import { randomUUID } from "node:crypto";
import {
  PlatformError,
  billingEntitlement,
  eventTypes,
  resourceReference,
  hash,
} from "./config.mjs";

const id = (value) => (typeof value === "string" ? value : value?.id);
const apiVersion = "2026-11-18.endive";
export function createBilling({ Stripe, config, vault, store }) {
  let client;
  async function stripe() {
    if (!config.refs.stripe)
      throw new PlatformError(
        503,
        "billing",
        "Subscription billing is not configured.",
      );
    if (!client) {
      const key = await vault.secret(config.refs.stripe);
      if (
        !/^[rs]k_(?:test|live)_/.test(key) ||
        key.includes("_live_") !== config.liveMode
      )
        throw new PlatformError(
          503,
          "stripe_mode",
          "The billing key and configured environment do not match.",
        );
      client = new Stripe(key, {
        apiVersion,
        maxNetworkRetries: 0,
        timeout: 20_000,
      });
    }
    return client;
  }
  async function price(plan) {
    const value = await (
      await stripe()
    ).prices.retrieve(plan.priceId, { expand: ["product"] });
    if (
      value.id !== plan.priceId ||
      value.active !== true ||
      value.type !== "recurring" ||
      value.recurring?.interval !== plan.interval ||
      value.recurring.interval_count !== 1 ||
      value.recurring.usage_type !== "licensed" ||
      !Number.isSafeInteger(value.unit_amount) ||
      value.unit_amount < 0 ||
      value.billing_scheme !== "per_unit" ||
      value.transform_quantity ||
      value.livemode !== config.liveMode
    )
      throw new PlatformError(
        503,
        "price_configuration",
        "The subscription Price no longer matches the approved fixed company plan.",
      );
    if (config.taxMode === "stripe_tax") {
      const provider = await stripe(),
        settings = await provider.tax.settings.retrieve();
      if (settings.status !== "active")
        throw new PlatformError(
          503,
          "tax_configuration",
          "Stripe Tax requires complete account and head-office settings before checkout.",
        );
      const registration = await provider.tax.registrations.list({
        status: "active",
        limit: 1,
      });
      if (!registration.data.length)
        throw new PlatformError(
          503,
          "tax_registration",
          "Stripe Tax requires reviewed active registrations before checkout.",
        );
      const taxCode =
          id(value.product?.tax_code) || id(settings.defaults?.tax_code),
        behavior =
          value.tax_behavior === "unspecified"
            ? settings.defaults?.tax_behavior
            : value.tax_behavior;
      if (!taxCode || !["inclusive", "exclusive"].includes(behavior))
        throw new PlatformError(
          503,
          "tax_configuration",
          "Review the subscription product tax code and tax behavior before checkout.",
        );
    }
    return {
      key: plan.key,
      name: plan.name,
      interval: plan.interval,
      currency: value.currency,
      unitAmount: value.unit_amount,
      displayAmount:
        value.currency === "usd"
          ? new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(value.unit_amount / 100)
          : null,
    };
  }
  async function plans() {
    return Promise.all(config.plans.map(price));
  }
  async function checkout(organization, account, planKey) {
    if (!config.liveMode && !config.testEmails?.includes(account.email))
      throw new PlatformError(
        403,
        "internal_testing",
        "Company subscriptions are currently limited to approved internal test accounts.",
      );
    if (config.blockers.length)
      throw new PlatformError(
        503,
        "readiness",
        "Company subscriptions are waiting for configuration and approved pricing.",
      );
    const plan = config.plans.find((p) => p.key === planKey);
    if (!plan)
      throw new PlatformError(400, "plan", "Choose an available company plan.");
    await price(plan);
    if (
      ["paid", "trial", "grandfathered", "risk_review"].includes(
        organization.entitlement,
      ) ||
      ["active", "trialing", "past_due", "unpaid", "paused"].includes(
        organization.subscription_status,
      )
    )
      throw new PlatformError(
        409,
        "subscription_exists",
        "Manage this company’s existing subscription through Billing.",
      );
    const attempt = await store.transaction(async (writer) => {
      const current = (
        await writer.query(
          "SELECT * FROM platform_organizations WHERE id=$1 FOR UPDATE",
          [organization.id],
        )
      ).rows[0];
      if (
        current.entitlement !== "none" ||
        ["active", "trialing", "past_due", "unpaid", "paused"].includes(
          current.subscription_status,
        )
      )
        throw new PlatformError(
          409,
          "subscription_exists",
          "This company already has a subscription or entitlement.",
        );
      const prior = (
        await writer.query(
          "SELECT * FROM platform_checkout_attempts WHERE organization_id=$1 AND state IN ('creating','open','payment_pending') FOR UPDATE",
          [organization.id],
        )
      ).rows[0];
      if (prior) {
        if (prior.price_id !== plan.priceId)
          throw new PlatformError(
            409,
            "checkout_open",
            "Finish or expire the existing company checkout before changing plans.",
          );
        return prior;
      }
      return (
        await writer.query(
          "INSERT INTO platform_checkout_attempts(id,organization_id,price_id,contract,customer_request) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            randomUUID(),
            organization.id,
            plan.priceId,
            {
              priceId: plan.priceId,
              trialDays: config.trialDays,
              taxMode: config.taxMode,
              origin: config.origin,
              termsUrl: config.termsUrl,
              approvedAt: new Date().toISOString(),
            },
            { name: organization.company_name, email: account.email },
          ],
        )
      ).rows[0];
    });
    if (
      Date.now() - new Date(attempt.created_at).getTime() > 23 * 3600_000 &&
      !attempt.session_id
    )
      throw new PlatformError(
        409,
        "checkout_unconfirmed",
        "The prior checkout could not be confirmed. Billing support must reconcile it before another checkout is created.",
      );
    const provider = await stripe();
    if (attempt.session_id) {
      const existing = await provider.checkout.sessions.retrieve(
        attempt.session_id,
      );
      if (existing.status === "open" && existing.url)
        return { url: checkoutUrl(existing.url), sessionId: existing.id };
      await store.query(
        "UPDATE platform_checkout_attempts SET state=$2,updated_at=now() WHERE id=$1 AND state IN ('creating','open','payment_pending')",
        [
          attempt.id,
          existing.status === "complete" ? "payment_pending" : "expired",
        ],
      );
      throw new PlatformError(
        409,
        "checkout_complete",
        "Checkout is complete or expired. Refresh Billing for the current subscription state.",
      );
    }
    let customer = organization.stripe_customer_id;
    if (!customer) {
      const remote = await provider.customers.create(attempt.customer_request, {
        idempotencyKey: `cw-customer-${attempt.id}`,
      });
      customer = remote.id;
      await store.query(
        "UPDATE platform_organizations SET stripe_customer_id=$2,updated_at=now() WHERE id=$1 AND (stripe_customer_id IS NULL OR stripe_customer_id=$2)",
        [organization.id, customer],
      );
    }
    const suffix = hash(attempt.id)
      .slice(0, 8)
      .split("")
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join("");
    let document = attempt.request_payload;
    if (!document) {
      const contract = attempt.contract;
      const proposed = {
        mode: "subscription",
        customer,
        client_reference_id: organization.id,
        line_items: [{ price: attempt.price_id, quantity: 1 }],
        integration_identifier: `catalyst_works_${suffix}`,
        success_url: `${contract.origin}/account/billing?checkout=returned`,
        cancel_url: `${contract.origin}/account/billing?checkout=cancelled`,
        consent_collection: { terms_of_service: "required" },
        ...(contract.taxMode === "stripe_tax"
          ? {
              automatic_tax: { enabled: true },
              customer_update: { address: "auto" },
              billing_address_collection: "required",
            }
          : {}),
        subscription_data: {
          billing_mode: { type: "flexible" },
          ...(contract.trialDays > 0
            ? {
                trial_period_days: contract.trialDays,
                trial_settings: {
                  end_behavior: { missing_payment_method: "cancel" },
                },
              }
            : {}),
        },
        ...(contract.trialDays > 0
          ? { payment_method_collection: "always" }
          : {}),
      };
      await store.query(
        "UPDATE platform_checkout_attempts SET request_payload=$2 WHERE id=$1 AND request_payload IS NULL",
        [attempt.id, proposed],
      );
      document = (
        await store.query(
          "SELECT request_payload FROM platform_checkout_attempts WHERE id=$1",
          [attempt.id],
        )
      ).rows[0].request_payload;
    }
    const session = await provider.checkout.sessions.create(document, {
      idempotencyKey: `cw-checkout-${attempt.id}`,
    });
    if (!session.url)
      throw new PlatformError(
        502,
        "checkout_unconfirmed",
        "Checkout did not return a payment page. Refresh Billing before trying again.",
      );
    await store.query(
      "UPDATE platform_checkout_attempts SET session_id=$2,url=$3,state=CASE WHEN state='creating' THEN 'open' ELSE state END,expires_at=to_timestamp($4),updated_at=now() WHERE id=$1 AND (session_id IS NULL OR session_id=$2)",
      [attempt.id, session.id, session.url, session.expires_at],
    );
    await store.audit("billing.checkout_created", {
      organizationId: organization.id,
      accountId: account.id,
      details: {
        sessionId: session.id,
        priceId: plan.priceId,
        livemode: config.liveMode,
      },
    });
    return { url: checkoutUrl(session.url), sessionId: session.id };
  }
  async function portal(organization) {
    if (
      !organization.stripe_customer_id ||
      organization.entitlement === "grandfathered"
    )
      throw new PlatformError(
        409,
        "portal",
        "No self-service subscription is linked to this company.",
      );
    const session = await (
      await stripe()
    ).billingPortal.sessions.create({
      customer: organization.stripe_customer_id,
      return_url: `${config.origin}/account/billing`,
      ...(config.portalConfiguration
        ? { configuration: config.portalConfiguration }
        : {}),
    });
    const url = new URL(session.url);
    if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com")
      throw new PlatformError(
        502,
        "portal",
        "The billing portal could not be opened.",
      );
    return { url: session.url };
  }
  async function webhook(raw, signature) {
    if (!config.refs.webhook || typeof signature !== "string")
      throw new PlatformError(
        400,
        "signature",
        "A signed billing event is required.",
      );
    let event;
    try {
      event = (await stripe()).webhooks.constructEvent(
        raw,
        signature,
        await vault.secret(config.refs.webhook),
      );
    } catch {
      throw new PlatformError(
        400,
        "signature",
        "The billing event signature is invalid.",
      );
    }
    if (event.livemode !== config.liveMode || event.account)
      throw new PlatformError(
        400,
        "stripe_mode",
        "The billing event belongs to another environment.",
      );
    if (!eventTypes.has(event.type)) return { received: true };
    if (event.api_version !== apiVersion)
      throw new PlatformError(
        409,
        "webhook_version",
        "Configure the billing webhook with the supported API version.",
      );
    const resource = resourceReference(event.data.object);
    if (!resource.id)
      throw new PlatformError(
        400,
        "event",
        "Billing event has no resource identifier.",
      );
    await store.query(
      "INSERT INTO platform_billing_events(id,event_type,livemode,resource) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
      [event.id, event.type, event.livemode, resource],
    );
    return { received: true };
  }
  async function subscriptionForInvoice(invoiceId, provider) {
    const invoice = await provider.invoices.retrieve(invoiceId);
    return invoice.parent?.type === "subscription_details"
      ? id(invoice.parent.subscription_details?.subscription)
      : null;
  }
  async function applySubscription(subscriptionId, { sessionId = null } = {}) {
    const provider = await stripe();
    const initial = await provider.subscriptions.retrieve(subscriptionId);
    if (initial.livemode !== config.liveMode)
      throw new PlatformError(
        409,
        "stripe_mode",
        "Subscription environment differs from the platform.",
      );
    const customerId = id(initial.customer);
    if (!customerId)
      throw new PlatformError(
        409,
        "subscription_customer",
        "Subscription ownership could not be verified.",
      );
    await store.transaction(async (writer) => {
      const org = (
        await writer.query(
          "SELECT o.*,a.email AS owner_email FROM platform_organizations o JOIN platform_accounts a ON a.id=o.owner_account_id WHERE o.stripe_customer_id=$1 FOR UPDATE OF o",
          [customerId],
        )
      ).rows[0];
      if (!org) return;
      if (org.entitlement === "grandfathered") return;
      // Fetch again after the company lock so an older worker cannot restore stale access.
      const sub = await provider.subscriptions.retrieve(subscriptionId, {
        expand: ["latest_invoice"],
      });
      if (id(sub.customer) !== customerId || sub.livemode !== config.liveMode)
        throw new PlatformError(
          409,
          "subscription_customer",
          "Subscription ownership changed during review.",
        );
      const approvedPrices = new Set(config.plans.map((p) => p.priceId));
      // Retain the immutable Price from this company's previously approved contract.
      if (
        org.stripe_subscription_id === sub.id &&
        org.profile?.subscriptionContract?.priceId
      )
        approvedPrices.add(org.profile.subscriptionContract.priceId);
      if (!org.stripe_subscription_id && !sessionId) return;
      let contract =
        org.stripe_subscription_id === sub.id
          ? org.profile?.subscriptionContract
          : null;
      if (sessionId) {
        const owned = (
          await writer.query(
            "SELECT id,contract FROM platform_checkout_attempts WHERE organization_id=$1 AND session_id=$2",
            [org.id, sessionId],
          )
        ).rows[0];
        if (!owned) return;
        if (!contract) contract = owned.contract;
      }
      if (contract?.priceId) approvedPrices.add(contract.priceId);
      if (org.stripe_subscription_id && org.stripe_subscription_id !== sub.id) {
        if (
          !sessionId ||
          !["canceled", "incomplete_expired"].includes(org.subscription_status)
        )
          return;
        const owned = (
          await writer.query(
            "SELECT id FROM platform_checkout_attempts WHERE organization_id=$1 AND session_id=$2",
            [org.id, sessionId],
          )
        ).rows[0];
        if (!owned) return;
      }
      const desired =
        contract &&
        (config.liveMode || config.testEmails?.includes(org.owner_email))
          ? billingEntitlement(sub, approvedPrices, contract.trialDays)
          : "none";
      const risk = (
        await writer.query(
          "SELECT id FROM platform_risk_reviews WHERE organization_id=$1 AND status='open' LIMIT 1",
          [org.id],
        )
      ).rows[0];
      const entitlement = risk ? "risk_review" : desired;
      const priceId = sub.items?.data?.[0]?.price?.id ?? null;
      const ends =
        sub.items?.data?.[0]?.current_period_end ?? sub.trial_end ?? null;
      await writer.query(
        "UPDATE platform_organizations SET stripe_subscription_id=$2,subscription_status=$3,subscription_price_id=$4,subscription_ends_at=to_timestamp($5),entitlement=$6,last_billing_sync=now(),state=CASE WHEN $6 IN ('paid','trial') THEN CASE WHEN state IN ('pending_payment','blocked','failed') THEN 'provisioning' ELSE state END ELSE 'blocked' END,updated_at=now(),revision=revision+1 WHERE id=$1",
        [org.id, sub.id, sub.status, priceId, ends, entitlement],
      );
      if (contract)
        await writer.query(
          "UPDATE platform_organizations SET profile=jsonb_set(profile,'{subscriptionContract}',$2::jsonb) WHERE id=$1",
          [org.id, JSON.stringify(contract)],
        );
      if (["paid", "trial"].includes(entitlement))
        await writer.query(
          "INSERT INTO platform_provisioning_jobs(organization_id) VALUES($1) ON CONFLICT(organization_id) DO UPDATE SET next_attempt_at=LEAST(platform_provisioning_jobs.next_attempt_at,now())",
          [org.id],
        );
      if (
        ["paid", "trial"].includes(entitlement) ||
        ["canceled", "incomplete_expired"].includes(sub.status)
      )
        await writer.query(
          "UPDATE platform_checkout_attempts SET state=$2,updated_at=now() WHERE organization_id=$1 AND state='payment_pending'",
          [
            org.id,
            ["paid", "trial"].includes(entitlement) ? "complete" : "expired",
          ],
        );
      await store.audit(
        "billing.subscription_reconciled",
        {
          organizationId: org.id,
          details: { subscriptionId: sub.id, status: sub.status, entitlement },
        },
        writer,
      );
    });
  }
  async function riskEvent(event, provider) {
    const chargeId =
      event.event_type === "charge.refunded"
        ? event.resource.id
        : event.resource.charge;
    const charge = chargeId ? await provider.charges.retrieve(chargeId) : null;
    const paymentIntent = id(charge?.payment_intent);
    const subscriptions = new Set();
    if (paymentIntent) {
      for await (const payment of provider.invoicePayments.list({
        payment: { type: "payment_intent", payment_intent: paymentIntent },
        status: "paid",
        limit: 100,
      })) {
        const subId = await subscriptionForInvoice(
          id(payment.invoice),
          provider,
        );
        if (subId) subscriptions.add(subId);
      }
    }
    const owners = [];
    for (const subId of subscriptions) {
      const sub = await provider.subscriptions.retrieve(subId);
      const org = (
        await store.query(
          "SELECT id FROM platform_organizations WHERE stripe_subscription_id=$1 AND stripe_customer_id=$2",
          [subId, id(sub.customer)],
        )
      ).rows[0];
      if (org) owners.push(org.id);
    }
    // A Stripe Customer is unique to one platform company. Unresolved risk stays visible for operator review.
    const owner =
      owners[0] ??
      (id(charge?.customer)
        ? (
            await store.query(
              "SELECT id FROM platform_organizations WHERE stripe_customer_id=$1",
              [id(charge.customer)],
            )
          ).rows[0]?.id
        : null) ??
      null;
    await store.transaction(async (writer) => {
      await writer.query(
        "INSERT INTO platform_risk_reviews(id,organization_id,event_id,reason,resource) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO NOTHING",
        [randomUUID(), owner, event.id, event.event_type, event.resource],
      );
      if (owner)
        await writer.query(
          "UPDATE platform_organizations SET entitlement='risk_review',state='blocked',updated_at=now(),revision=revision+1 WHERE id=$1 AND entitlement<>'grandfathered'",
          [owner],
        );
      await store.audit(
        "billing.risk_review_required",
        {
          organizationId: owner,
          details: { eventId: event.id, type: event.event_type },
        },
        writer,
      );
    });
  }
  async function processEvent(event) {
    const provider = await stripe();
    if (
      [
        "charge.refunded",
        "charge.dispute.created",
        "radar.early_fraud_warning.created",
      ].includes(event.event_type)
    )
      return riskEvent(event, provider);
    if (event.event_type === "customer.updated") {
      const customer = await provider.customers.retrieve(event.resource.id);
      if (customer.deleted) return;
      await store.query(
        "UPDATE platform_organizations SET profile=jsonb_set(profile,'{billingCustomer}',$2::jsonb),updated_at=now() WHERE stripe_customer_id=$1",
        [
          customer.id,
          JSON.stringify({
            name: customer.name,
            email: customer.email,
            address: customer.address,
          }),
        ],
      );
      return;
    }
    let subscriptionId, sessionId;
    if (event.event_type.startsWith("customer.subscription."))
      subscriptionId = event.resource.id;
    else if (event.event_type.startsWith("invoice."))
      subscriptionId = await subscriptionForInvoice(
        event.resource.id,
        provider,
      );
    else if (event.event_type.startsWith("checkout.session.")) {
      const session = await provider.checkout.sessions.retrieve(
        event.resource.id,
      );
      if (
        session.mode !== "subscription" ||
        session.livemode !== config.liveMode
      )
        return;
      const org = (
        await store.query(
          "SELECT id,stripe_customer_id FROM platform_organizations WHERE stripe_customer_id=$1",
          [id(session.customer)],
        )
      ).rows[0];
      if (!org || session.client_reference_id !== org.id) return;
      await store.query(
        "UPDATE platform_checkout_attempts SET state=$3,session_id=COALESCE(session_id,$2),updated_at=now() WHERE organization_id=$1 AND state IN ('creating','open','payment_pending') AND (session_id=$2 OR (session_id IS NULL AND state='creating'))",
        [
          org.id,
          session.id,
          session.status === "complete"
            ? "payment_pending"
            : session.status === "expired"
              ? "expired"
              : "open",
        ],
      );
      if (session.payment_status === "unpaid") return;
      subscriptionId = id(session.subscription);
      sessionId = session.id;
    }
    if (subscriptionId) await applySubscription(subscriptionId, { sessionId });
  }
  return {
    stripe,
    plans,
    checkout,
    portal,
    webhook,
    processEvent,
    applySubscription,
  };
}
function checkoutUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
    throw new PlatformError(
      502,
      "checkout",
      "The payment page could not be opened.",
    );
  return value;
}
