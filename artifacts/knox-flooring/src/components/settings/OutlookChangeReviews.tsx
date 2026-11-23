import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { installationBookingHref, operation, useOperation } from "@/lib/operations";

interface Snapshot {
  id: string; etag: string; changeKey: string; subject: string;
  startAt: string; endAt: string; isCancelled: boolean; isAllDay: boolean; type: string;
}
export interface OutlookChangeReview {
  bookingId: string; jobNumber: string; crewName: string; bookingRevision: number; reviewRevision: number;
  kind: "edited" | "deleted" | "unverified"; detectedAt: string;
  local: { startAt: string; endAt: string; status: string; plannedLaborHours: number };
  previous: Snapshot | null; remote: Snapshot | null;
}
const path = "/calendar/outlook/reviews";
const date = (value: string) => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Time unavailable";

export function OutlookChangeReviews() {
  const reviews = useOperation<{ reviews: OutlookChangeReview[] }>(path, ["owner"]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  if (!reviews.allowed) return null;
  async function resolve(row: OutlookChangeReview, action: "use_outlook" | "reapply_local") {
    setBusy(row.bookingId); setError(""); setMessage("");
    try {
      await operation(`${path}/${encodeURIComponent(row.bookingId)}/resolve`, "POST", {
        bookingRevision: row.bookingRevision, reviewRevision: row.reviewRevision, action, note: notes[row.bookingId].trim(),
      });
      setMessage(`${row.jobNumber}: calendar change resolved.`);
      await reviews.refetch();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The calendar change could not be resolved."); }
    finally { setBusy(null); }
  }
  return <section aria-label="Outlook calendar changes" className="space-y-3 rounded-md border p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">Outlook calendar changes</h3>
      <Button size="sm" variant="outline" disabled={busy !== null || reviews.isFetching} onClick={() => void reviews.refetch()}>Refresh changes</Button></div>
    <p className="text-muted-foreground">Changes made in Outlook pause automatic updates for the affected booking. Review both schedules and choose which to keep.</p>
    {reviews.isLoading && <p role="status">Loading calendar changes…</p>}
    {reviews.error && <p role="alert">Calendar changes could not be loaded. Refresh to try again.</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {message && <p role="status">{message}</p>}
    {reviews.data?.reviews.length === 0 && <p>No Outlook changes awaiting review.</p>}
    {reviews.data?.reviews.map(row => {
      const removed = row.kind === "deleted" || row.remote?.isCancelled === true;
      const canUseRemote = removed || Boolean(row.remote && !row.remote.isAllDay && row.remote.type === "singleInstance");
      const canSubmit = busy === null && Boolean(notes[row.bookingId]?.trim());
      return <article key={row.bookingId} aria-label={`${row.jobNumber} calendar change`} className="space-y-3 rounded-md border bg-background p-3">
        <div><Link className="font-medium underline" href={installationBookingHref({ id: row.bookingId, startAt: row.local.startAt })}>{row.jobNumber}</Link>
          <p>{row.crewName}</p><p className="text-muted-foreground">{removed ? "The Outlook event was removed or canceled." : row.kind === "unverified" ? "This event needs an initial schedule review." : "This event was changed in Outlook."}</p></div>
        <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="font-medium">App schedule</dt><dd>{date(row.local.startAt)} → {date(row.local.endAt)}</dd><dd>{row.local.status}</dd></div>
          <div><dt className="font-medium">Outlook schedule</dt><dd>{removed ? "Removed or canceled" : row.remote ? `${date(row.remote.startAt)} → ${date(row.remote.endAt)}` : "Unavailable"}</dd>{row.remote?.subject && <dd>{row.remote.subject}</dd>}</div></dl>
        {!canUseRemote && <p>The Outlook event needs a supported start and end time before its schedule can be accepted.</p>}
        <div className="space-y-1"><Label htmlFor={`outlook-note-${row.bookingId}`}>Review note for {row.jobNumber}</Label><Input id={`outlook-note-${row.bookingId}`} maxLength={500} value={notes[row.bookingId] ?? ""} onChange={event => setNotes(previous => ({ ...previous, [row.bookingId]: event.target.value }))} placeholder="Reason for this schedule choice" /></div>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!canSubmit || !canUseRemote} onClick={() => void resolve(row, "use_outlook")}>{removed ? "Cancel this booking" : "Use Outlook schedule"}</Button>
          <Button size="sm" variant="outline" disabled={!canSubmit} onClick={() => void resolve(row, "reapply_local")}>Keep app schedule</Button></div>
        {removed && <p className="text-muted-foreground">Canceling changes this booking; the job and its history remain available.</p>}
      </article>;
    })}
  </section>;
}
