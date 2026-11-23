import { useEffect, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProductBrand } from "@/components/layout/Brand";
import {
  httpsLink,
  platformRequest,
  type PlatformReadiness,
} from "@/lib/platform-client";

export default function CompanySignup() {
  const [readiness, setReadiness] = useState<PlatformReadiness>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    slug: "",
    acceptedTerms: false,
  });
  useEffect(() => {
    let active = true;
    platformRequest<PlatformReadiness>("/readiness")
      .then((value) => {
        if (active) setReadiness(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const terms = httpsLink(readiness?.termsUrl),
    privacy = httpsLink(readiness?.privacyUrl);
  const available = readiness?.signupAvailable && terms && privacy;
  async function signup(event: FormEvent) {
    event.preventDefault();
    if (!available || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await platformRequest<{ message: string }>(
        "/signup",
        "POST",
        form,
      );
      setMessage(result.message);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Company signup could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-[#FAF7F1] px-5 py-8">
      <div className="mx-auto max-w-2xl">
        <ProductBrand />
        <div className="mt-8 rounded-xl border bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-2xl font-semibold">
            Create your company account
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Verify your email, review the available subscription, then set up
            your company workspace.
          </p>
          {!readiness && !error && (
            <p role="status" className="mt-5">
              Checking signup availability…
            </p>
          )}
          {readiness && !available && (
            <div role="status" className="my-5 rounded-lg border bg-muted p-4">
              <p className="font-medium">New company signup is not open yet.</p>
              <p className="mt-2 text-sm">
                Existing company accounts can still manage their subscriptions
                below.
              </p>
            </div>
          )}
          {message ? (
            <p
              role="status"
              className="my-6 rounded-lg bg-emerald-50 p-4 text-emerald-900"
            >
              {message}
            </p>
          ) : (
            <form onSubmit={signup} className="mt-6 space-y-4">
              <fieldset disabled={!available || busy} className="space-y-4">
                {(
                  [
                    {
                      key: "name",
                      label: "Your name",
                      type: "text",
                      autoComplete: "name",
                    },
                    {
                      key: "email",
                      label: "Work email",
                      type: "email",
                      autoComplete: "email",
                    },
                    {
                      key: "company",
                      label: "Company name",
                      type: "text",
                      autoComplete: "organization",
                    },
                    {
                      key: "slug",
                      label: "Company web address",
                      type: "text",
                      autoComplete: "off",
                    },
                  ] as const
                ).map((field) => (
                  <div key={field.key}>
                    <Label htmlFor={`signup-${field.key}`}>{field.label}</Label>
                    <Input
                      className="mt-1"
                      id={`signup-${field.key}`}
                      type={field.type}
                      autoComplete={field.autoComplete}
                      required
                      maxLength={
                        field.key === "slug"
                          ? 40
                          : field.key === "email"
                            ? 254
                            : 150
                      }
                      pattern={
                        field.key === "slug"
                          ? "[a-z][a-z0-9-]{1,38}[a-z0-9]"
                          : undefined
                      }
                      value={form[field.key]}
                      onChange={(event) =>
                        setForm((value) => ({
                          ...value,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                    {field.key === "slug" && readiness?.tenantDomain && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {form.slug || "your-company"}.{readiness.tenantDomain}
                      </p>
                    )}
                  </div>
                ))}
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    required
                    checked={form.acceptedTerms}
                    onChange={(event) =>
                      setForm((value) => ({
                        ...value,
                        acceptedTerms: event.target.checked,
                      }))
                    }
                  />
                  <span>
                    I accept the{" "}
                    {terms ? (
                      <a
                        className="underline"
                        href={terms}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        subscription terms
                      </a>
                    ) : (
                      "subscription terms"
                    )}{" "}
                    and have read the{" "}
                    {privacy ? (
                      <a
                        className="underline"
                        href={privacy}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        privacy notice
                      </a>
                    ) : (
                      "privacy notice"
                    )}
                    .
                  </span>
                </label>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!available || busy || !form.acceptedTerms}
                >
                  {busy ? "Sending verification…" : "Verify email and continue"}
                </Button>
              </fieldset>
            </form>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-5 text-sm">
            <Link className="text-primary underline" href="/account/billing">
              Manage an existing company account
            </Link>
            <Link className="text-primary underline" href="/welcome">
              Workspace sign in
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
