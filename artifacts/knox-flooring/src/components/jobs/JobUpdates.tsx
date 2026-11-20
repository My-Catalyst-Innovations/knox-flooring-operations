import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { operation, useOperation } from "@/lib/operations";
import { formatStageDateTime } from "@/lib/stages";

interface JobUpdate { id: string; authorName: string; message: string; createdAt: string }

export function JobUpdates({ jobId }: { jobId: string }) {
  const path = `/jobs/${encodeURIComponent(jobId)}/updates`;
  const history = useOperation<JobUpdate[]>(path);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);
  const request = useRef<{ id: string; message: string } | null>(null);

  async function saveUpdate() {
    const message = text.trim();
    if (!message || pending.current) return;
    if (request.current?.message !== message) request.current = { id: crypto.randomUUID(), message };
    pending.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await operation(path, "POST", request.current);
      request.current = null;
      setText("");
      setSaved(true);
      void history.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to save this update.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Job updates</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void saveUpdate(); }}>
          <label className="block space-y-1 text-sm">
            <span>Quick update</span>
            <Textarea rows={2} maxLength={1500} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} placeholder="What changed or needs attention?" />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !text.trim()}>{busy ? "Saving…" : "Save update"}</Button>
            {saved && <p role="status" className="text-sm text-muted-foreground">Update saved for your team.</p>}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </form>
        {history.isError ? <p className="text-sm text-muted-foreground">Updates could not load. <button className="underline" onClick={() => void history.refetch()}>Retry</button></p> : (
          <ol className="divide-y">
            {history.data?.map((update) => (
              <li key={update.id} className="space-y-1 py-2">
                <p className="text-xs text-muted-foreground">{update.authorName} · {formatStageDateTime(update.createdAt)}</p>
                <p className="whitespace-pre-wrap break-words text-sm">{update.message}</p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
