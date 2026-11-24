import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import {
  quickBooksEntryPaths,
  quickBooksSignInPath,
  type QuickBooksEntryIntent,
} from "@workspace/domain";
import { useAuth } from "@/contexts/auth";
import { ProductBrand } from "@/components/layout/Brand";
import { Button } from "@/components/ui/button";
import {
  quickBooksAuthorizationDestination,
  quickBooksOAuthAvailable,
  quickBooksRevocationUnresolved,
  verifiedQuickBooksEntryStatus,
  type QuickBooksEntryStatus,
} from "@/lib/quickbooks-entry";

const titles = {
  launch: "QuickBooks in Catalyst Works",
  connect: "Connect QuickBooks",
  reconnect: "Reconnect QuickBooks",
  disconnect: "Disconnect QuickBooks",
};
const descriptions = {
  launch:
    "Review the connection for your existing company workspace, then open its accounting settings.",
  connect:
    "The workspace owner can authorize QuickBooks after reviewing the correct company and environment.",
  reconnect:
    "Renew authorization for your workspace. A pending or uncertain revocation must be resolved before another connection can start.",
  disconnect:
    "Stop this workspace’s use of QuickBooks and request revocation from Intuit. Existing jobs and accounting history are retained.",
};
export function QuickBooksEntry({
  intent,
  navigate = (url) => window.location.assign(url),
}: {
  intent: QuickBooksEntryIntent;
  navigate?: (url: string) => void;
}) {
  const { user, loading: sessionLoading } = useAuth();
  const allowed =
    user?.role === "owner" &&
    (!user.actualRole || user.actualRole === "owner") &&
    !user.previewRole;
  const identity = allowed ? user.id : null,
    activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const [status, setStatus] = useState<QuickBooksEntryStatus | null>(null),
    [statusLoading, setStatusLoading] = useState(false),
    [loadCount, setLoadCount] = useState(0),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  const working = useRef(false);
  useEffect(() => {
    setStatus(null);
    setConfirmed(false);
    setError("");
    if (!allowed || sessionLoading) {
      setStatusLoading(false);
      return;
    }
    const controller = new AbortController();
    setStatusLoading(true);
    void customFetch<unknown>("/api/quickbooks/entry-status", {
      responseType: "json",
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const next = verifiedQuickBooksEntryStatus(value);
        if (!next) throw new Error("Unverified status");
        setStatus(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus(null);
          setError(
            "The saved connection state could not be verified. Reload before taking any account action.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatusLoading(false);
      });
    return () => controller.abort();
  }, [allowed, identity, sessionLoading, loadCount, intent]);
  const reload = () => {
    setStatus(null);
    setConfirmed(false);
    setStatusLoading(true);
    setLoadCount((value) => value + 1);
  };
  const connect = async () => {
    if (
      working.current ||
      !allowed ||
      !status ||
      !quickBooksOAuthAvailable(status) ||
      statusLoading
    )
      return;
    working.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const actor = identity;
    try {
      const result = await customFetch<{ authorizationUrl: unknown }>(
        "/api/quickbooks/connect",
        { responseType: "json" },
      );
      const url = quickBooksAuthorizationDestination(result.authorizationUrl);
      if (!url || activeIdentity.current !== actor)
        throw new Error("Invalid authorization destination");
      navigate(url);
    } catch {
      setError(
        "Authorization could not be started safely. Reload the saved connection or review QuickBooks settings before trying again.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (
      working.current ||
      !allowed ||
      !status ||
      !confirmed ||
      statusLoading ||
      status.connection.status === "error"
    )
      return;
    working.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    const retryRevocation =
      status.connection.localUseStopped &&
      quickBooksRevocationUnresolved(status);
    if (retryRevocation && !status.connection.revocationRetryAvailable) {
      working.current = false;
      setBusy(false);
      return;
    }
    try {
      const result = await customFetch<{ revocation?: unknown }>(
        "/api/quickbooks/disconnect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retryRevocation }),
          responseType: "json",
        },
      );
      setMessage(
        result.revocation === "confirmed"
          ? "The disconnect request returned confirmed Intuit revocation. Review the current saved state below."
          : "Intuit revocation was not confirmed by this response. Review the saved local stop and revocation state before any further action.",
      );
    } catch {
      setMessage(
        "The disconnect response could not be confirmed. Local access may already have stopped; Intuit revocation is not confirmed by an interrupted response. Reload the saved state and use only an explicit retry for that stopped grant.",
      );
    } finally {
      working.current = false;
      setBusy(false);
      reload();
    }
  };
  const connection = allowed ? status?.connection : null;
  const unresolved = status ? quickBooksRevocationUnresolved(status) : false;
  const canDisconnect =
    !!connection &&
    connection.status !== "error" &&
    (connection.connected ||
      connection.status === "reconnect_required" ||
      (connection.localUseStopped && unresolved));
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-6 px-5 py-8 sm:py-12">
      <ProductBrand />
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">
          {titles[intent]}
        </h1>
        <p className="mt-3 text-muted-foreground">{descriptions[intent]}</p>
      </header>
      <p className="rounded border bg-muted/30 p-4 text-sm">
        Access is provided for your existing company workspace. Connecting does
        not approve invoices, import balances, send messages or post accounting
        entries. Review those separately inside Works.
      </p>
      {sessionLoading ? (
        <p role="status">Checking your workspace sign-in…</p>
      ) : !allowed ? (
        <section className="space-y-3 rounded border p-4">
          <h2 className="font-semibold">Workspace owner access</h2>
          <p>
            {user
              ? "This action requires the actual workspace owner outside role preview. Your current sign-in cannot view or change the connection here."
              : "Sign in with the owner account supplied for your company workspace. This page does not create an account or select a company from a link."}
          </p>
          {!user && (
            <Button asChild>
              <Link href={quickBooksSignInPath(intent)}>
                Sign in to continue
              </Link>
            </Button>
          )}
          {user && (
            <Button variant="outline" asChild>
              <Link href="/">Return to workspace</Link>
            </Button>
          )}
        </section>
      ) : (
        <section className="space-y-4 rounded border p-4">
          <h2 className="font-semibold">Saved workspace connection</h2>
          <p className="text-sm">
            This page reads saved setup. It does not test Intuit access or
            approve accounting entries.
          </p>
          {statusLoading && <p role="status">Loading the saved connection…</p>}
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          {connection && (
            <>
              <dl className="grid gap-3 sm:grid-cols-2">
                <div>
                  <dt>Company</dt>
                  <dd>{connection.companyName || "No company name saved"}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    {connection.environment === "production"
                      ? "Production"
                      : connection.environment === "sandbox"
                        ? "Sandbox testing"
                        : "Not connected"}
                  </dd>
                </div>
                <div>
                  <dt>Current saved authorization</dt>
                  <dd>
                    {connection.connected
                      ? "Connected"
                      : connection.status === "reconnect_required"
                        ? "Reauthorization required"
                        : connection.status === "error"
                          ? "Needs operator review"
                          : connection.localUseStopped
                            ? "Local use stopped"
                            : "No active saved connection"}
                  </dd>
                </div>
                <div>
                  <dt>Intuit revocation</dt>
                  <dd>
                    {connection.revocation === "confirmed"
                      ? "Confirmed for the stopped grant"
                      : connection.revocation === "not_requested"
                        ? connection.localUseStopped
                          ? "No revocation outcome recorded — not confirmed"
                          : "Not requested"
                        : connection.revocation === "not_connected"
                          ? "No saved grant to revoke"
                          : connection.revocation === "pending"
                            ? "Pending — not confirmed"
                            : connection.revocation === "unknown"
                              ? "Unknown — not confirmed"
                              : "Failed — not confirmed"}
                  </dd>
                </div>
              </dl>
              {!status!.configured && (
                <p>
                  QuickBooks is not configured for this workspace. Your
                  implementation contact must complete setup before
                  authorization can start.
                </p>
              )}
              {connection.status === "error" && (
                <p role="alert">
                  The saved state needs review. No account action is offered
                  until it can be interpreted safely.
                </p>
              )}
              {unresolved && !connection.revocationRetryAvailable && (
                <p>
                  The retained grant cannot currently be retried safely. Keep
                  new authorization paused and ask your implementation contact
                  to review the saved state.
                </p>
              )}
              {unresolved && (
                <p>
                  New authorization is paused until the stopped grant’s Intuit
                  revocation is confirmed. Reload its status or explicitly retry
                  revocation on the disconnect page.
                </p>
              )}
              {(intent === "connect" || intent === "reconnect") && (
                <>
                  {intent === "connect" && connection.connected ? (
                    <p>
                      This workspace already has a saved connection. Review it
                      in settings or use the explicit reconnect page.
                    </p>
                  ) : (
                    <Button
                      disabled={
                        busy ||
                        statusLoading ||
                        !quickBooksOAuthAvailable(status!)
                      }
                      onClick={() => void connect()}
                    >
                      {busy
                        ? "Starting authorization…"
                        : intent === "reconnect" && !connection.localUseStopped
                          ? "Reauthorize QuickBooks"
                          : "Continue to Intuit authorization"}
                    </Button>
                  )}
                </>
              )}
              {intent === "disconnect" &&
                (canDisconnect ? (
                  <div className="space-y-3 border-t pt-4">
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        disabled={busy || statusLoading}
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      {connection.localUseStopped
                        ? "I want to retry Intuit revocation for this same stopped grant. This does not reconnect or discard its history."
                        : "Stop local QuickBooks use and request Intuit revocation for the saved connection shown above. Keep all accounting history."}
                    </label>
                    <Button
                      variant="destructive"
                      disabled={
                        !confirmed ||
                        busy ||
                        statusLoading ||
                        (connection.localUseStopped &&
                          !connection.revocationRetryAvailable)
                      }
                      onClick={() => void disconnect()}
                    >
                      {busy
                        ? "Request in progress…"
                        : connection.localUseStopped
                          ? "Retry Intuit revocation"
                          : "Stop use and request revocation"}
                    </Button>
                  </div>
                ) : (
                  <p>
                    {connection.revocation === "confirmed"
                      ? "No further revocation request is needed for this stopped grant. A new connection requires a separate explicit authorization."
                      : "There is no interpretable active grant to disconnect here. Review the saved state or settings."}
                  </p>
                ))}
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" asChild>
                  <Link href="/settings">Open QuickBooks settings</Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link href="/">Open workspace</Link>
                </Button>
              </div>
            </>
          )}
          <Button
            variant="outline"
            disabled={busy || statusLoading}
            onClick={reload}
          >
            Reload saved connection
          </Button>
        </section>
      )}
      <nav
        aria-label="QuickBooks connection pages"
        className="flex flex-wrap gap-4 text-sm"
      >
        {Object.entries(quickBooksEntryPaths)
          .filter(([key]) => key !== intent)
          .map(([key, path]) => (
            <Link key={key} href={path} className="text-primary underline">
              {key === "launch"
                ? "Connection overview"
                : key === "connect"
                  ? "Connect"
                  : key === "reconnect"
                    ? "Reconnect"
                    : "Disconnect"}
            </Link>
          ))}
        <Link href="/help/quickbooks" className="text-primary underline">
          QuickBooks help
        </Link>
      </nav>
      <footer className="flex flex-wrap gap-4 border-t pt-4 text-sm">
        <a href="/privacy" className="text-primary underline">
          Privacy notice
        </a>
        <a href="/terms" className="text-primary underline">
          Terms of use
        </a>
      </footer>
    </main>
  );
}
