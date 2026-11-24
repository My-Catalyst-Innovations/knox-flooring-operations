import { useState, type FormEvent } from "react";
import { useAuth } from "@/contexts/auth";
import { useOperation } from "@/lib/operations";
import {
  SmsPreferencePanel,
  smsRecipient,
  type SmsPreference,
} from "@/components/communications/sms-preference-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const officeRoles = ["owner", "sales", "operations"];
const noRoles: string[] = [];

export default function TextPreferences() {
  const { user } = useAuth();
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const allowed = Boolean(user && officeRoles.includes(user.role));
  const query = useOperation<SmsPreference>(
    `/sms-preferences/recipient?to=${encodeURIComponent(selected)}`,
    allowed && selected ? officeRoles : noRoles,
  );
  const preference =
    allowed &&
    !query.isFetching &&
    !query.isError &&
    query.data?.to === selected
      ? query.data
      : undefined;

  const lookup = (event: FormEvent) => {
    event.preventDefault();
    const to = smsRecipient(input);
    if (!to) {
      setSelected("");
      setError(
        "Enter a ten-digit US number or a number with its country code.",
      );
      return;
    }
    setError("");
    if (to === selected) void query.refetch();
    else setSelected(to);
  };

  if (!allowed)
    return <p>Text preferences are available to office staff only.</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Text preferences</h1>
        <p className="text-sm text-muted-foreground">
          Look up a recipient to record an opt-out or review operational text
          permission. This page does not send messages.
        </p>
        <p className="text-sm text-muted-foreground">
          Office staff can record an opt-out. An owner must review permission
          for the current company sender. Recording evidence does not verify
          carrier approval or delivery.
        </p>
        {user?.previewRole && (
          <p role="status" className="text-sm">
            Role preview is read-only. Exit preview before changing text
            preferences.
          </p>
        )}
      </div>
      <form onSubmit={lookup} className="space-y-2">
        <Label htmlFor="text-preference-phone">Recipient phone number</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="text-preference-phone"
            type="tel"
            autoComplete="off"
            className="max-w-sm"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setSelected("");
              setError("");
            }}
            placeholder="Phone number with area or country code"
          />
          <Button type="submit">Look up preference</Button>
        </div>
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
      </form>
      {selected && (
        <section
          aria-label={`Text preference for ${selected}`}
          className="space-y-3"
        >
          <p>
            Selected recipient: <strong>{selected}</strong>
          </p>
          {query.isFetching && (
            <p role="status">Checking the current preference…</p>
          )}
          {query.isError && (
            <div role="alert" className="space-y-2">
              <p>
                The recipient’s current text preference could not be confirmed.
                Refresh before sharing, sending or recording a change.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void query.refetch()}
              >
                Refresh preference
              </Button>
            </div>
          )}
          {preference && (
            <>
              <p className="text-sm">{preference.permission.reason}</p>
              <SmsPreferencePanel
                key={selected}
                to={selected}
                preference={preference}
                onRefresh={() => query.refetch()}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}
