import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ProductBrand } from "@/components/layout/Brand";
import { Button } from "@/components/ui/button";
import { platformRequest } from "@/lib/platform-client";

export default function PlatformVerify() {
  const [, navigate] = useLocation();
  const [token] = useState(() =>
    new URLSearchParams(window.location.hash.slice(1)).get("token"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.delete("token");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search,
    );
  }, []);
  async function verify() {
    if (!token || busy) return;
    setBusy(true);
    setError("");
    try {
      await platformRequest("/auth/verify", "POST", { token });
      navigate("/account/billing", { replace: true });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "This account link could not be verified.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-[#FAF7F1] px-5 py-10">
      <div className="mx-auto max-w-lg">
        <ProductBrand />
        <section className="mt-8 rounded-xl border bg-white p-7">
          <h1 className="text-2xl font-semibold">
            Confirm your account request
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Continue only if you requested this account or sign-in email.
          </p>
          {token ? (
            <Button
              className="mt-6 w-full"
              disabled={busy}
              onClick={() => void verify()}
            >
              {busy ? "Verifying…" : "Confirm and continue"}
            </Button>
          ) : (
            <p role="status" className="mt-5">
              This page needs the complete link from your account email. Request
              a fresh link if it expired.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <Link
            className="mt-6 inline-block text-sm text-primary underline"
            href="/account/billing"
          >
            Request another sign-in link
          </Link>
        </section>
      </div>
    </main>
  );
}
