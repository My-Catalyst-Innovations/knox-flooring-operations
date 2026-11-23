import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CompanySignup from "./company-signup";
import PlatformVerify from "./platform-verify";
import PlatformBilling from "./platform-billing";
import { billingDestination } from "@/lib/platform-client";

const fetchMock = vi.fn<typeof fetch>();
const readiness = {
  enabled: true,
  signupAvailable: true,
  blockers: [],
  tenantDomain: "works.example.test",
  termsUrl: "https://example.test/terms",
  privacyUrl: "https://example.test/privacy",
  trialDays: 0,
  plans: [
    {
      key: "configured",
      name: "Configured company plan",
      interval: "month",
      currency: "usd",
      unitAmount: 12345,
    },
  ],
};
const organization = {
  id: "organization-1",
  slug: "company-one",
  company_name: "Company One",
  profile: { phone: "", address: "" },
  state: "pending_payment",
  entitlement: "none",
  revision: 2,
  origin: null,
};
const account = {
  account: {
    id: "account-1",
    name: "Company Owner",
    email: "owner@example.test",
  },
  csrfToken: "separate-platform-csrf",
  organizations: [organization],
};
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState({}, "", "/");
  fetchMock.mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith("/readiness")
        ? readiness
        : String(url).endsWith("/account")
          ? account
          : { message: "Request saved." },
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps unapproved signup disabled and hides technical configuration details", async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      ...readiness,
      signupAvailable: false,
      plans: [],
      blockers: ["Key Vault secret is missing", "Configure managed identity"],
    }),
  );
  render(<CompanySignup />);
  expect(
    await screen.findByText("New company signup is not open yet."),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Verify email and continue" }),
  ).toBeDisabled();
  expect(
    screen.queryByText(/Key Vault|managed identity/),
  ).not.toBeInTheDocument();
  expect(
    fetchMock.mock.calls.every(([, options]) => options?.method === "GET"),
  ).toBe(true);
});
it("submits only entered company details after explicit acceptance of published terms", async () => {
  render(<CompanySignup />);
  await waitFor(() => expect(screen.getByLabelText("Your name")).toBeEnabled());
  for (const [label, value] of [
    ["Your name", "Company Owner"],
    ["Work email", "owner@example.test"],
    ["Company name", "Company One"],
    ["Company web address", "company-one"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(
    screen.getByRole("button", { name: "Verify email and continue" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Verify email and continue" }),
  );
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/signup",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          name: "Company Owner",
          email: "owner@example.test",
          company: "Company One",
          slug: "company-one",
          acceptedTerms: true,
        }),
      }),
    ),
  );
  expect(await screen.findByText("Request saved.")).toBeVisible();
});
it("does not consume an account link until the user confirms and removes its fragment immediately", async () => {
  window.history.replaceState(
    {},
    "",
    "/account/verify#token=private-link-token",
  );
  render(<PlatformVerify />);
  expect(window.location.hash).toBe("");
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and continue" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/auth/verify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "private-link-token" }),
      }),
    ),
  );
});
it("does not accept a credential supplied in the query string", () => {
  window.history.replaceState({}, "", "/account/verify?token=must-not-be-used");
  render(<PlatformVerify />);
  expect(
    screen.queryByRole("button", { name: "Confirm and continue" }),
  ).not.toBeInTheDocument();
  expect(window.location.search).toBe("");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("uses the distinct platform CSRF token for profile updates", async () => {
  render(<PlatformBilling />);
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Updated Owner" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save account" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/account",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-platform-csrf": "separate-platform-csrf",
        },
        body: JSON.stringify({
          name: "Updated Owner",
          email: "owner@example.test",
        }),
      }),
    ),
  );
});
it("includes the current company revision and waits for server readiness before exposing a workspace", async () => {
  fetchMock.mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith("/readiness")
        ? readiness
        : String(url).endsWith("/account")
          ? {
              ...account,
              organizations: [
                {
                  ...organization,
                  state: "owner_pending",
                  origin: "https://company-one.works.example.test",
                },
              ],
            }
          : { message: "Company profile saved." },
    ),
  );
  render(<PlatformBilling />);
  const phone = await screen.findByLabelText("Company phone");
  expect(
    screen.queryByRole("link", { name: "Open workspace" }),
  ).not.toBeInTheDocument();
  fireEvent.change(phone, { target: { value: "+1 865 555 0100" } });
  fireEvent.click(screen.getByRole("button", { name: "Save company details" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/platform/organizations/organization-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          companyName: "Company One",
          phone: "+1 865 555 0100",
          address: "",
          revision: 2,
        }),
      }),
    ),
  );
});
it("checks pending owner activation without reissuing or invalidating setup credentials", async () => {
  fetchMock.mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith("/readiness")
        ? readiness
        : {
            ...account,
            organizations: [
              { ...organization, state: "owner_pending", entitlement: "paid" },
            ],
          },
    ),
  );
  render(<PlatformBilling />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Check workspace setup" }),
  );
  expect(await screen.findByText("Workspace status refreshed.")).toBeVisible();
  expect(
    fetchMock.mock.calls.every(([, options]) => options?.method === "GET"),
  ).toBe(true);
});
it("shows configured offers without inventing trials and ignores checkout return parameters as access proof", async () => {
  window.history.replaceState({}, "", "/account/billing?checkout=returned");
  render(<PlatformBilling />);
  expect(await screen.findByText("$123.45 per month")).toBeVisible();
  expect(screen.queryByText(/day trial/i)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open workspace" }),
  ).not.toBeInTheDocument();
});
it("keeps checkout unavailable when server offers are not approved", async () => {
  fetchMock.mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith("/readiness")
        ? {
            ...readiness,
            signupAvailable: false,
            blockers: ["Technical provisioning flag missing"],
          }
        : account,
    ),
  );
  render(<PlatformBilling />);
  expect(
    await screen.findByText("Subscriptions are not open for new checkout yet."),
  ).toBeVisible();
  expect(screen.queryByText("$123.45 per month")).not.toBeInTheDocument();
  expect(screen.queryByText(/Technical provisioning/)).not.toBeInTheDocument();
});
it("requests a magic link when the central account has no session", async () => {
  fetchMock.mockImplementation(async (url) =>
    String(url).endsWith("/account")
      ? Response.json({ error: "Sign in." }, { status: 401 })
      : Response.json(
          String(url).endsWith("/readiness")
            ? readiness
            : { message: "Check your email." },
        ),
  );
  render(<PlatformBilling />);
  fireEvent.change(await screen.findByLabelText("Account email"), {
    target: { value: "owner@example.test" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Email me a sign-in link" }),
  );
  expect(await screen.findByText("Check your email.")).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/platform/auth/request",
    expect.objectContaining({
      body: JSON.stringify({ email: "owner@example.test" }),
    }),
  );
});
it("accepts only Stripe's expected HTTPS destinations for billing redirects", () => {
  expect(
    billingDestination("https://checkout.stripe.com/c/pay/test", "checkout"),
  ).toContain("checkout.stripe.com");
  for (const url of [
    "https://evil.example.test/pay",
    "https://checkout.stripe.com.evil.test/pay",
    "javascript:alert(1)",
    "https://user@checkout.stripe.com/pay",
  ])
    expect(() => billingDestination(url, "checkout")).toThrow();
});
