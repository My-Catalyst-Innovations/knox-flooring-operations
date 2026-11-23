import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { operation, useOperation } from "@/lib/operations";

const path = "/calendar/outlook";

interface OutlookStatus {
  configured: boolean;
  status:
    | "not_configured"
    | "disconnected"
    | "connected"
    | "reconnect_required";
  accountName: string | null;
  mailConnected: boolean;
  mailboxEmail: string | null;
  calendar: { id: string; name: string | null } | null;
  pending: {
    bookingId: string;
    jobNumber: string;
    error: string | null;
    retryAt: string | null;
  }[];
}

interface CalendarOption {
  id: string;
  name: string;
  owner?: { name?: string; address?: string } | null;
}

export function OutlookSettings() {
  const {
    allowed,
    data: status,
    isLoading,
    isError,
    refetch,
  } = useOperation<OutlookStatus>(`${path}/status`, ["owner"]);
  const callback = new URLSearchParams(useSearch()).get("outlook");
  const [calendars, setCalendars] = useState<CalendarOption[] | null>(null);
  const [calendarId, setCalendarId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const connected = status?.status === "connected";
  const pending = status?.pending.length ?? 0;
  useEffect(() => {
    if (!connected || !pending) return;
    const timer = window.setInterval(() => void refetch(), 8000);
    return () => window.clearInterval(timer);
  }, [connected, pending, refetch]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Outlook Calendar could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function connect(mail = false) {
    const connection = await operation<{ authorizationUrl: string }>(
      `${path}/connect`,
      "POST",
      mail ? { mail: true } : undefined,
    );
    window.location.assign(connection.authorizationUrl);
  }

  if (!allowed) return null;
  const callbackError =
    callback === "account_mismatch"
      ? "Reconnect the Microsoft account that owns the previously synced bookings."
      : callback === "failed" || callback === "invalid"
        ? "Outlook authorization did not finish. Connect Outlook again."
        : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Microsoft Outlook</CardTitle>
        <CardDescription>
          Publish confirmed crew bookings to your chosen calendar and optionally
          send customer emails from your Microsoft mailbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <p role="status" className="text-sm">
            Checking Outlook connection…
          </p>
        )}
        {isError && (
          <p role="alert" className="text-sm">
            Outlook connection status is unavailable.{" "}
            <button className="underline" onClick={() => void refetch()}>
              Retry
            </button>
          </p>
        )}
        {status && !status.configured && (
          <p className="text-sm text-muted-foreground">
            Microsoft Entra connection settings are required on this server.
          </p>
        )}
        {status?.configured && (
          <>
            {connected ? (
              <p className="text-sm">
                {status.accountName} connected.{" "}
                {status.calendar
                  ? `Publishing new bookings to ${status.calendar.name ?? "the selected calendar"}.`
                  : "Choose a calendar to begin publishing."}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {status.status === "reconnect_required"
                  ? "Microsoft authorization expired. Reconnect to resume syncing bookings."
                  : "Outlook is disconnected."}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {!connected && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await connect();
                    })
                  }
                >
                  Connect Outlook
                </Button>
              )}
              {connected && (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const next = await operation<CalendarOption[]>(
                          `${path}/calendars`,
                        );
                        setCalendars(next);
                        setCalendarId(
                          next.some(
                            (option) => option.id === status.calendar?.id,
                          )
                            ? status.calendar!.id
                            : "",
                        );
                      })
                    }
                  >
                    {status.calendar ? "Change calendar" : "Choose calendar"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await operation(`${path}/disconnect`, "POST");
                        setCalendars(null);
                        await refetch();
                        setMessage(
                          "Outlook disconnected. Previously published calendar events remain in Outlook.",
                        );
                      })
                    }
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </div>
            {connected && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">Outlook email</p>
                {status.mailConnected ? (
                  <p>
                    Customer emails can be sent from {status.mailboxEmail ?? "your connected Microsoft mailbox"}.
                    {" "}Choose Outlook when composing an email. Submitted messages
                    appear in Outlook Sent Items.
                  </p>
                ) : (
                  <>
                    <p className="text-muted-foreground">
                      Allow Catalyst Works to send email as your connected Microsoft
                      account. This requests send permission and does not read your
                      inbox. Your calendar connection continues to work separately.
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void run(() => connect(true))}
                    >
                      Enable Outlook email
                    </Button>
                  </>
                )}
                <p className="text-muted-foreground">
                  Password resets and other system emails use the company email service.
                </p>
              </div>
            )}
            {connected &&
              calendars &&
              (calendars.length ? (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block min-w-0 grow space-y-1 text-sm">
                    <span>Writable calendar</span>
                    <select
                      className="block h-10 w-full rounded-md border bg-background px-3"
                      disabled={busy}
                      value={calendarId}
                      onChange={(event) => setCalendarId(event.target.value)}
                    >
                      <option value="">Select a calendar</option>
                      {calendars.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                          {option.owner?.address
                            ? ` · ${option.owner.address}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    disabled={busy || !calendarId}
                    onClick={() =>
                      void run(async () => {
                        const selected = await operation<{ name: string }>(
                          `${path}/calendar`,
                          "PUT",
                          { calendarId },
                        );
                        setCalendars(null);
                        await refetch();
                        setMessage(
                          `New bookings will publish to ${selected.name}. Previously linked bookings keep their original calendar.`,
                        );
                      })
                    }
                  >
                    Use calendar
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No writable calendars were found. Accept the calendar share in
                  Outlook and try again.
                </p>
              ))}
            {connected && status.calendar && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await operation<{ queued: number }>(
                        `${path}/publish-upcoming`,
                        "POST",
                      );
                      await refetch();
                      setMessage(
                        result.queued
                          ? `${result.queued} upcoming bookings queued for Outlook.`
                          : "No new upcoming bookings to publish.",
                      );
                    })
                  }
                >
                  Publish existing upcoming bookings
                </Button>
                {pending > 0 && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await operation(`${path}/retry`, "POST");
                        await refetch();
                        setMessage(
                          "Outlook retry requested. Requests with a future retry time remain queued.",
                        );
                      })
                    }
                  >
                    Retry pending bookings
                  </Button>
                )}
              </div>
            )}
            {pending > 0 && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">Bookings waiting for Outlook</p>
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {status.pending.map((item) => (
                    <li key={item.bookingId} className="text-muted-foreground">
                      {item.jobNumber} · {item.error ?? "Queued"}
                      {item.retryAt &&
                        ` · Retry after ${new Date(item.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {(error || callbackError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || callbackError}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
