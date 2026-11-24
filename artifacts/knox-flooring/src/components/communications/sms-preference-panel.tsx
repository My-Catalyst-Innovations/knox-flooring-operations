import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/contexts/auth";
import { operation } from "@/lib/operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface SmsPreference {
  to: string;
  revision: number;
  permission: {
    status: string;
    canSendLive: boolean;
    canDeviceShare: boolean;
    reason: string;
  };
  binding: {
    fingerprint: string;
    provider: string;
    sender: string;
    companyLabel: string;
    projectLabel: string;
  } | null;
  history: Array<{
    id: string;
    kind: string;
    recordedAt: string;
    occurredAt: string | null;
    note: string;
    synthetic: boolean;
    releasedSuppression: boolean;
    evidence: Record<string, unknown> | null;
    bindingFingerprint?: string | null;
  }>;
  hasMore: boolean;
}
const names: Record<string, string> = {
  evidence_recorded: "Evidence recorded",
  suppressed_manual: "Office opt-out",
  suppressed_inbound: "Signed text opt-out",
  inbound_start_request: "Signed opt-in request; review required",
  legacy_stop: "Retained earlier opt-out",
};
const sources: Record<string, string> = {
  written: "Written permission",
  web_form: "Web form",
  verbal: "Verbal permission",
  inbound_request: "Reviewed inbound request",
};
export function smsRecipient(value: string) {
  const number = value.trim().replace(/[().\s-]/g, "");
  if (/^\d{10}$/.test(number)) return `+1${number}`;
  if (/^1\d{10}$/.test(number)) return `+${number}`;
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}
export function SmsPreferencePanel({
  to,
  preference,
  onRefresh,
}: {
  to: string;
  preference: SmsPreference | undefined;
  onRefresh: () => unknown;
}) {
  const { user } = useAuth(),
    id = useId();
  const [note, setNote] = useState(""),
    [source, setSource] = useState("written"),
    [when, setWhen] = useState(""),
    [reference, setReference] = useState("");
  const [synthetic, setSynthetic] = useState(true),
    [confirmed, setConfirmed] = useState(false),
    [release, setRelease] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const pending = useRef(false);
  const current = preference?.to === to ? preference : undefined;
  const owner =
    user?.role === "owner" &&
    (user.actualRole ?? user.role) === "owner" &&
    !user.previewRole;
  const office =
    !!user &&
    ["owner", "sales", "operations"].includes(user.role) &&
    !user.previewRole;
  useEffect(() => {
    setConfirmed(false);
    setRelease(false);
    setNote("");
    setWhen("");
    setReference("");
    setSynthetic(true);
    setMessage("");
    attempt.current = null;
  }, [to]);
  useEffect(() => {
    setConfirmed(false);
    setRelease(false);
  }, [current?.revision, current?.binding?.fingerprint]);
  if (
    !current ||
    !user ||
    !["owner", "sales", "operations"].includes(user.role)
  )
    return null;
  const occurredAt = Date.parse(when);
  const validWhen =
    Number.isFinite(occurredAt) &&
    occurredAt >= Date.UTC(2000, 0, 1) &&
    occurredAt <= Date.now();
  const save = async (kind: "consent" | "suppress") => {
    if (pending.current || !office || !current || current.to !== to) return;
    if (kind === "suppress" && note.trim().length < 5) return;
    if (
      kind === "consent" &&
      (!owner || !confirmed || !validWhen || note.trim().length < 10)
    )
      return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const input =
        kind === "suppress"
          ? { to, revision: current.revision, note: note.trim() }
          : {
              to,
              revision: current.revision,
              bindingFingerprint: current.binding?.fingerprint ?? null,
              evidence: {
                source,
                occurredAt: new Date(when).toISOString(),
                note: note.trim(),
                reference: reference.trim(),
                synthetic,
              },
              releaseSuppression: release,
            };
      const fingerprint = JSON.stringify([kind, input]);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, key: crypto.randomUUID() };
      await operation(`/sms-preferences/${kind}`, "POST", {
        ...input,
        requestKey: attempt.current.key,
      });
      setMessage(
        kind === "suppress"
          ? `Opt-out recorded for ${to}. Provider requests already in flight cannot be recalled.`
          : `Evidence recorded for ${to}. No text was sent.`,
      );
      attempt.current = null;
      setConfirmed(false);
      try {
        await onRefresh();
      } catch {
        setMessage(
          `The preference for ${to} was saved, but its latest status could not be loaded. Refresh before sharing or sending.`,
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The preference change was not confirmed. Refresh before another action.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Text preference and evidence
      </summary>
      <div className="mt-3 space-y-3">
        <p>
          Recipient: <strong>{to}</strong>
        </p>
        <p>{current.permission.reason}</p>
        <p>
          {current.binding
            ? `${current.binding.companyLabel} · ${current.binding.sender} · ${current.binding.projectLabel}`
            : "Sender not configured. Evidence can be saved unbound; it will not permit provider sends."}
        </p>
        <p className="text-xs text-muted-foreground">
          Operational texts only. Recording evidence does not verify carrier
          approval or delivery. A START reply is a request for review.
        </p>
        {office && (
          <>
            <div>
              <Label htmlFor={`${id}-note`}>Evidence or opt-out note</Label>
              <Textarea
                id={`${id}-note`}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setConfirmed(false);
                }}
                maxLength={1500}
                disabled={busy}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={busy || note.trim().length < 5}
              onClick={() => save("suppress")}
            >
              Record opt-out for {to}
            </Button>
            {owner && (
              <fieldset disabled={busy} className="space-y-3 border-t pt-3">
                <legend className="font-medium">Owner evidence review</legend>
                <div>
                  <Label htmlFor={`${id}-source`}>Evidence source</Label>
                  <select
                    id={`${id}-source`}
                    className="block w-full rounded border p-2"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="written">Written permission</option>
                    <option value="web_form">Web form</option>
                    <option value="verbal">Verbal permission</option>
                    <option value="inbound_request">
                      Reviewed inbound request
                    </option>
                  </select>
                </div>
                <div>
                  <Label htmlFor={`${id}-when`}>
                    When the recipient gave permission
                  </Label>
                  <Input
                    id={`${id}-when`}
                    type="datetime-local"
                    step="1"
                    value={when}
                    onChange={(e) => {
                      setWhen(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use the actual past time in your device’s time zone.
                  </p>
                  {when && !validWhen && (
                    <p className="text-sm">
                      Enter a valid past time from 2000 onward.
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor={`${id}-reference`}>
                    Evidence reference (optional)
                  </Label>
                  <Input
                    id={`${id}-reference`}
                    value={reference}
                    onChange={(e) => {
                      setReference(e.target.value);
                      setConfirmed(false);
                    }}
                    maxLength={500}
                  />
                </div>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={synthetic}
                    onChange={(e) => {
                      setSynthetic(e.target.checked);
                      if (e.target.checked) setRelease(false);
                      setConfirmed(false);
                    }}
                  />
                  This is fictional/test evidence. It cannot authorize provider
                  sends.
                </label>
                {current.permission.status === "suppressed" && (
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={release}
                      disabled={synthetic || !current.binding}
                      onChange={(e) => {
                        setRelease(e.target.checked);
                        setConfirmed(false);
                      }}
                    />
                    Explicitly release this opt-out after reviewing new real
                    permission given later than the opt-out.
                  </label>
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I reviewed this evidence for {to}
                  {current.binding
                    ? ` and sender ${current.binding.sender}`
                    : ". It will remain unbound"}
                  .
                </label>
                <Button
                  type="button"
                  disabled={
                    busy || !confirmed || !validWhen || note.trim().length < 10
                  }
                  onClick={() => save("consent")}
                >
                  Record reviewed evidence
                </Button>
              </fieldset>
            )}
          </>
        )}
        {message && <p role="status">{message}</p>}
        <h4 className="font-medium">Recent preference history</h4>
        {current.history.length === 0 ? (
          <p>No evidence or preference change is recorded.</p>
        ) : (
          <ul className="space-y-2">
            {current.history.map((event) => (
              <li key={event.id} className="border-t pt-2">
                <p>
                  {Object.hasOwn(names, event.kind)
                    ? names[event.kind]
                    : event.kind}{" "}
                  · {new Date(event.recordedAt).toLocaleString()}
                </p>
                <p>{event.note}</p>
                {typeof event.evidence?.source === "string" &&
                  Object.hasOwn(sources, event.evidence.source) && (
                    <p>Source: {sources[event.evidence.source]}</p>
                  )}
                {typeof event.evidence?.reference === "string" &&
                  event.evidence.reference && (
                    <p>Reference: {event.evidence.reference}</p>
                  )}
                {event.kind === "evidence_recorded" &&
                  event.bindingFingerprint &&
                  event.bindingFingerprint !== current.binding?.fingerprint && (
                    <p>
                      Evidence was recorded for an earlier sender connection.
                    </p>
                  )}
                {event.occurredAt && (
                  <p>
                    Evidence time: {new Date(event.occurredAt).toLocaleString()}
                  </p>
                )}
                {event.synthetic && <p>Fictional/test evidence</p>}
                {event.releasedSuppression && (
                  <p>Owner explicitly released opt-out</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {current.hasMore && (
          <p>Older evidence remains retained in the audit ledger.</p>
        )}
      </div>
    </details>
  );
}
