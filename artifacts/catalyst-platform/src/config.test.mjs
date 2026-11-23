import test from "node:test";
import assert from "node:assert/strict";
import {
  billingEntitlement,
  companyInput,
  readPlatformConfig,
  tenantOrigin,
  vaultReference,
} from "./config.mjs";
test("signup remains unavailable without explicit platform configuration", () => {
  assert.equal(readPlatformConfig({}).enabled, false);
});
test("signup rejects role tricks, reserved companies and unaccepted terms", () => {
  const input = {
    name: "Owner",
    email: "OWNER@example.test",
    company: "Company",
    slug: "new-company",
    acceptedTerms: true,
  };
  assert.deepEqual(
    companyInput({
      ...input,
      role: "owner",
      databaseUrl: "postgres://untrusted",
    }),
    {
      name: "Owner",
      email: "owner@example.test",
      company: "Company",
      slug: "new-company",
    },
  );
  assert.throws(() => companyInput({ ...input, slug: "knoxville" }));
  assert.throws(() => companyInput({ ...input, acceptedTerms: false }));
  assert.throws(() => companyInput({ ...input, slug: "../../knoxville" }));
});
test("vault references and generated tenant origins cannot select an arbitrary host", () => {
  assert.equal(
    vaultReference(
      "https://private.vault.azure.net/secrets/platform-key",
      "https://private.vault.azure.net",
    ),
    "https://private.vault.azure.net/secrets/platform-key",
  );
  assert.throws(() =>
    vaultReference(
      "https://evil.test/secrets/key",
      "https://private.vault.azure.net",
    ),
  );
  assert.equal(
    tenantOrigin("new-company", { suffix: "works.example.test" }),
    "https://new-company.works.example.test",
  );
});
test("billing access requires exactly the configured company subscription and never the redirect", () => {
  const subscription = {
    id: "sub_owned",
    customer: "cus_owned",
    status: "active",
    items: {
      data: [
        {
          quantity: 1,
          price: { id: "price_approved" },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      ],
    },
    latest_invoice: {
      status: "paid",
      amount_remaining: 0,
      customer: "cus_owned",
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_owned" },
      },
    },
  };
  const prices = new Set(["price_approved"]);
  assert.equal(billingEntitlement(subscription, prices, 0), "paid");
  for (const status of [
    "incomplete",
    "incomplete_expired",
    "past_due",
    "unpaid",
    "canceled",
    "paused",
  ])
    assert.equal(
      billingEntitlement({ ...subscription, status }, prices, 0),
      "none",
    );
  assert.equal(
    billingEntitlement({ ...subscription, status: "trialing" }, prices, 0),
    "none",
  );
  assert.equal(
    billingEntitlement(
      {
        ...subscription,
        status: "trialing",
        trial_start: Math.floor(Date.now() / 1000),
        trial_end: Math.floor(Date.now() / 1000) + 14 * 86400,
      },
      prices,
      14,
    ),
    "trial",
  );
  assert.equal(
    billingEntitlement(
      {
        ...subscription,
        latest_invoice: { ...subscription.latest_invoice, status: "open" },
      },
      prices,
      14,
    ),
    "none",
  );
  assert.equal(
    billingEntitlement(subscription, new Set(["price_other"]), 14),
    "none",
  );
  assert.equal(
    billingEntitlement(
      {
        ...subscription,
        items: {
          data: [...subscription.items.data, ...subscription.items.data],
        },
      },
      prices,
      0,
    ),
    "none",
  );
});
