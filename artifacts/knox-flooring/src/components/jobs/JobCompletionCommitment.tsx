import { useId, useState } from "react";
import type { CompletionCommitment } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth";
import { operation, useRefreshOperations } from "@/lib/operations";
import { recordedJobDate } from "@/lib/reporting";
import type { Job } from "@/lib/types";

export function JobCompletionCommitment({ job }: { job: Job }) {
  const { user } = useAuth();
  const refresh = useRefreshOperations();
  const inputId = useId();
  const recorded = job.committedCompletionDate ?? "";
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const draft = dateDraft ?? recorded;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const canEdit =
    user?.role === "owner" &&
    !["Completed", "Invoiced"].includes(job.status) &&
    !recordedJobDate(job, "completed");

  async function save() {
    if (pending || !job.revision || draft === recorded) return;
    setPending(true);
    setError("");
    setSaved("");
    try {
      await operation<CompletionCommitment>(
        `/jobs/${encodeURIComponent(job.id)}/committed-completion`,
        "PUT",
        { date: draft || null, revision: job.revision },
      );
      setSaved(
        draft
          ? "Committed completion date saved."
          : "Committed completion date cleared.",
      );
      await refresh();
      setDateDraft(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save the committed completion date.",
      );
    } finally {
      setPending(false);
    }
  }

  if (!canEdit)
    return (
      <div className="text-sm">
        <p className="mb-1 text-muted-foreground">Committed completion date</p>
        <p className="text-base font-medium">{recorded || "Unknown"}</p>
      </div>
    );

  return (
    <form
      className="space-y-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Label htmlFor={inputId} className="text-muted-foreground">
        Committed completion date
      </Label>
      <p
        id={`${inputId}-description`}
        className="text-xs text-muted-foreground"
      >
        Use the completion date agreed with the customer.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          aria-describedby={`${inputId}-description`}
          className="w-40"
          type="date"
          value={draft}
          onChange={(event) => {
            setDateDraft(event.target.value);
            setSaved("");
          }}
          disabled={pending}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending || !job.revision || draft === recorded}
        >
          {pending
            ? "Saving…"
            : !draft && recorded
              ? "Clear date"
              : "Save date"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-xs text-muted-foreground">
          {saved}
        </p>
      )}
    </form>
  );
}
