import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { ProductBrand } from "@/components/layout/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  billingDestination,
  httpsLink,
  platformRequest,
  PlatformRequestError,
  type PlatformReadiness,
} from "@/lib/platform-client";

interface Organization {
  id: string;
  slug: string;
  company_name: string;
  profile: { phone?: string; address?: string };
  state: string;
  entitlement: string;
  subscription_status?: string;
  subscription_ends_at?: string;
  revision: number;
  origin: string | null;
  setupPending?: boolean;
  operatorConfigurationRequired?: boolean;
}
interface AccountData {
  account: { id: string; name: string; email: string };
  csrfToken: string;
  organizations: Organization[];
}
const stateLabel = (org: Organization) =>
  org.state === "ready"
    ? "Workspace ready"
    : org.state === "owner_pending"
      ? "Check your email to activate the owner account"
      : org.state === "provisioning"
        ? "Preparing your workspace"
        : org.state === "pending_payment"
          ? "Choose a company subscription"
          : org.state === "blocked"
            ? "Your subscription needs attention"
            : "Workspace setup needs attention";
const money = (plan: PlatformReadiness["plans"][number]) =>
  plan.displayAmount ??
  (plan.currency.toLowerCase() === "usd"
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
      }).format(plan.unitAmount / 100)
    : "Review price at checkout");

export default function PlatformBilling() {
  const [readiness, setReadiness] = useState<PlatformReadiness>();
  const [data, setData] = useState<AccountData>();
  const [loginNeeded, setLoginNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState({ name: "", email: "" });
  const [companyEdits, setCompanyEdits] = useState<
    Record<string, { companyName: string; phone: string; address: string }>
  >({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      platformRequest<PlatformReadiness>("/readiness"),
      platformRequest<AccountData>("/account"),
    ]);
    if (results[0].status === "fulfilled") setReadiness(results[0].value);
    if (results[1].status === "fulfilled") {
      const account = results[1].value;
      setData(account);
      setLoginNeeded(false);
      setProfile({ name: account.account.name, email: account.account.email });
      setCompanyEdits(
        Object.fromEntries(
          account.organizations.map((org) => [
            org.id,
            {
              companyName: org.company_name,
              phone: org.profile?.phone ?? "",
              address: org.profile?.address ?? "",
            },
          ]),
        ),
      );
    } else if (
      results[1].reason instanceof PlatformRequestError &&
      results[1].reason.status === 401
    ) {
      setData(undefined);
      setLoginNeeded(true);
    } else throw results[1].reason;
  }, []);
  useEffect(() => {
    void load()
      .catch((error) => setError(error.message))
      .finally(() => setLoading(false));
  }, [load]);
  async function perform(
    key: string,
    action: () => Promise<{ message?: string } | unknown>,
    success = "Saved.",
  ) {
    if (busy) return;
    setBusy(key);
    setError("");
    setMessage("");
    try {
      const result = (await action()) as { message?: string };
      setMessage(result?.message ?? success);
      await load();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "This account action could not be completed.",
      );
    } finally {
      setBusy("");
    }
  }
  async function requestLink(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("login");
    setError("");
    try {
      setMessage(
        (
          await platformRequest<{ message: string }>("/auth/request", "POST", {
            email,
          })
        ).message,
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The sign-in link could not be requested.",
      );
    } finally {
      setBusy("");
    }
  }
  async function openBilling(
    org: Organization,
    kind: "checkout" | "portal",
    planKey?: string,
  ) {
    if (!data) return;
    await perform(
      `${kind}-${org.id}-${planKey ?? ""}`,
      async () => {
        const result = await platformRequest<{ url: string }>(
          `/organizations/${org.id}/${kind}`,
          "POST",
          kind === "checkout" ? { planKey } : {},
          data.csrfToken,
        );
        window.location.assign(billingDestination(result.url, kind));
      },
      "Opening secure billing…",
    );
  }
  return (
    <main className="min-h-screen bg-[#FAF7F1] px-5 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <ProductBrand />
          <Link className="text-sm text-primary underline" href="/welcome">
            Workspace sign in
          </Link>
        </div>
        <h1 className="mt-8 text-2xl font-semibold">
          Company account and billing
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage your account, company details, and subscription.
        </p>
        {loading && (
          <p role="status" className="mt-6">
            Loading your account…
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-5 rounded border border-destructive/30 bg-white p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {message && (
          <p
            role="status"
            className="mt-5 rounded bg-emerald-50 p-3 text-sm text-emerald-900"
          >
            {message}
          </p>
        )}
        {loginNeeded && (
          <section className="mt-6 max-w-lg rounded-xl border bg-white p-6">
            <h2 className="text-lg font-semibold">
              Sign in to your company account
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              We will email you a secure sign-in link.
            </p>
            <form className="mt-4 space-y-3" onSubmit={requestLink}>
              <Label htmlFor="account-email">Account email</Label>
              <Input
                id="account-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button type="submit" disabled={Boolean(busy)}>
                {busy === "login"
                  ? "Requesting link…"
                  : "Email me a sign-in link"}
              </Button>
            </form>
            <Link
              className="mt-5 inline-block text-sm text-primary underline"
              href="/signup"
            >
              Create a company account
            </Link>
          </section>
        )}
        {data && (
          <>
            <section className="mt-6 rounded-xl border bg-white p-6">
              <h2 className="text-lg font-semibold">Your account</h2>
              <form
                className="mt-4 grid gap-4 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform("profile", () =>
                    platformRequest(
                      "/account",
                      "PATCH",
                      profile,
                      data.csrfToken,
                    ),
                  );
                }}
              >
                <div>
                  <Label htmlFor="account-name">Name</Label>
                  <Input
                    id="account-name"
                    required
                    maxLength={150}
                    value={profile.name}
                    onChange={(event) =>
                      setProfile((value) => ({
                        ...value,
                        name: event.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="account-profile-email">Email</Label>
                  <Input
                    id="account-profile-email"
                    type="email"
                    required
                    maxLength={254}
                    value={profile.email}
                    onChange={(event) =>
                      setProfile((value) => ({
                        ...value,
                        email: event.target.value,
                      }))
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Changing your email requires verification of the new address.
                </p>
                <Button className="justify-self-start" disabled={Boolean(busy)}>
                  Save account
                </Button>
              </form>
              <Button
                variant="link"
                className="mt-3 px-0"
                disabled={Boolean(busy)}
                onClick={() =>
                  void perform(
                    "logout",
                    () =>
                      platformRequest(
                        "/auth/logout",
                        "POST",
                        {},
                        data.csrfToken,
                      ),
                    "Signed out.",
                  )
                }
              >
                Sign out of company billing
              </Button>
            </section>
            {data.organizations.length === 0 && (
              <p className="mt-6">
                No companies are linked to this account.{" "}
                <Link className="text-primary underline" href="/signup">
                  Create your company
                </Link>
                .
              </p>
            )}
            {data.organizations.map((org) => {
              const draft = companyEdits[org.id];
              const destination =
                org.state === "ready" ? httpsLink(org.origin) : null;
              const subscriptionExists =
                ["paid", "trial", "risk_review", "grandfathered"].includes(
                  org.entitlement,
                ) ||
                ["active", "trialing", "past_due", "unpaid", "paused"].includes(
                  org.subscription_status ?? "",
                );
              return (
                <section
                  key={org.id}
                  className="mt-6 space-y-5 rounded-xl border bg-white p-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-semibold">
                        {org.company_name}
                      </h2>
                      <p className="mt-1 text-sm" role="status">
                        {stateLabel(org)}
                      </p>
                    </div>
                    {destination && (
                      <a
                        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
                        href={destination}
                      >
                        Open workspace
                      </a>
                    )}
                  </div>
                  {org.state === "owner_pending" && (
                    <p className="text-sm text-muted-foreground">
                      Use the account setup link sent to your verified email.
                      Refresh this page after setting your workspace password.
                    </p>
                  )}
                  {draft && (
                    <form
                      className="grid gap-4 sm:grid-cols-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(`company-${org.id}`, () =>
                          platformRequest(
                            `/organizations/${org.id}`,
                            "PATCH",
                            { ...draft, revision: org.revision },
                            data.csrfToken,
                          ),
                        );
                      }}
                    >
                      {(
                        [
                          {
                            key: "companyName",
                            label: "Company name",
                            max: 150,
                          },
                          { key: "phone", label: "Company phone", max: 40 },
                          {
                            key: "address",
                            label: "Company address",
                            max: 500,
                          },
                        ] as const
                      ).map((field) => (
                        <div key={field.key}>
                          <Label htmlFor={`${org.id}-${field.key}`}>
                            {field.label}
                          </Label>
                          <Input
                            id={`${org.id}-${field.key}`}
                            required={field.key === "companyName"}
                            maxLength={field.max}
                            value={draft[field.key]}
                            onChange={(event) =>
                              setCompanyEdits((value) => ({
                                ...value,
                                [org.id]: {
                                  ...draft,
                                  [field.key]: event.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                      ))}
                      <Button
                        className="self-end justify-self-start"
                        disabled={Boolean(busy)}
                      >
                        Save company details
                      </Button>
                    </form>
                  )}
                  <div className="border-t pt-4">
                    <h3 className="font-medium">Subscription</h3>
                    {org.subscription_status && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Status: {org.subscription_status.replaceAll("_", " ")}
                      </p>
                    )}
                    {subscriptionExists ? (
                      <>
                        {org.entitlement === "grandfathered" ? (
                          <p className="mt-2 text-sm">
                            This company uses an existing service agreement.
                          </p>
                        ) : (
                          <Button
                            variant="outline"
                            className="mt-3"
                            disabled={Boolean(busy)}
                            onClick={() => void openBilling(org, "portal")}
                          >
                            Manage subscription and payment details
                          </Button>
                        )}
                      </>
                    ) : readiness?.signupAvailable &&
                      readiness.plans.length > 0 ? (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {readiness.plans.map((plan) => (
                          <div key={plan.key} className="rounded-lg border p-4">
                            <p className="font-medium">{plan.name}</p>
                            <p className="mt-1 text-sm">
                              {money(plan)} per {plan.interval}
                            </p>
                            {Boolean(readiness.trialDays) && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {readiness.trialDays}-day trial. Review the full
                                terms at checkout.
                              </p>
                            )}
                            <Button
                              className="mt-3"
                              disabled={Boolean(busy)}
                              onClick={() =>
                                void openBilling(org, "checkout", plan.key)
                              }
                            >
                              Continue with {plan.name}
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">
                        Subscriptions are not open for new checkout yet.
                      </p>
                    )}
                  </div>
                  {org.state === "owner_pending" && (
                    <Button
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void perform(
                          `check-${org.id}`,
                          async () => {},
                          "Workspace status refreshed.",
                        )
                      }
                    >
                      Check workspace setup
                    </Button>
                  )}
                  {["failed", "provisioning"].includes(org.state) && (
                    <Button
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void perform(
                          `retry-${org.id}`,
                          () =>
                            platformRequest(
                              `/organizations/${org.id}/retry`,
                              "POST",
                              {},
                              data.csrfToken,
                            ),
                          "Workspace setup retry requested.",
                        )
                      }
                    >
                      Retry workspace setup
                    </Button>
                  )}
                </section>
              );
            })}
            <Button
              variant="outline"
              className="my-6"
              disabled={Boolean(busy)}
              onClick={() =>
                void perform("refresh", async () => {}, "Account refreshed.")
              }
            >
              Refresh account
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
