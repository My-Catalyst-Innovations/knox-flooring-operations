import { useRef, useState } from "react";
import { useAuth } from "@/contexts/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { operation, useOperation } from "@/lib/operations";
import { fileSrc, useStoredFileUpload } from "@/lib/file-upload";
import { microsoftFileUrl } from "@/lib/microsoft-file-links";

interface JobFileData {
  documents: { id: string; jobId: string; name: string; objectPath: string; size: number; sha256: string; createdAt: string }[];
  photos: { id: string; objectPath: string; name: string; caption: string; createdAt: string }[];
  microsoft: { connected: boolean; targetReady: boolean; folderUrl: string | null; mirrors: FileMirror[] };
}
interface FileMirror { id: string; sourceType: "document" | "photo"; sourceId: string; name: string; status: "syncing" | "synced" | "unknown" | "error"; webUrl: string | null; lastError: string | null; updatedAt: string }

export function JobFiles({ jobId }: { jobId: string }) {
  const path = `/jobs/${encodeURIComponent(jobId)}`;
  const { allowed, data, isLoading, isError, refetch } = useOperation<JobFileData>(`${path}/files`, ["owner", "sales", "operations"]);
  const { user } = useAuth();
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const syncing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const { uploadFile, isUploading } = useStoredFileUpload(cause => setError(cause.message));
  const canSync = user?.role === "owner" || user?.role === "operations";
  if (!allowed) return null;
  const folderUrl = microsoftFileUrl(data?.microsoft.folderUrl);
  async function sync(sourceType: "document" | "photo", sourceId: string) {
    if (syncing.current) return;
    syncing.current = true; setBusyId(`${sourceType}:${sourceId}`); setError("");
    try {
      await operation(`${path}/microsoft-files/sync`, "POST", { sourceType, sourceId, idempotencyKey: crypto.randomUUID() });
      await refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The file could not be copied to Microsoft."); await refetch(); }
    finally { syncing.current = false; setBusyId(""); }
  }
  function row(sourceType: "document" | "photo", source: { id: string; name: string; objectPath: string; caption?: string }) {
    const mirror = data?.microsoft.mirrors.find(item => item.sourceType === sourceType && item.sourceId === source.id);
    const microsoftUrl = microsoftFileUrl(mirror?.webUrl);
    const storedUrl = fileSrc(source.objectPath);
    return <li key={`${sourceType}:${source.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0 text-sm"><p className="break-all font-medium">{source.name || source.caption || (sourceType === "photo" ? "Job photo" : "Job document")}</p>
        <p className="text-xs text-muted-foreground">{sourceType === "photo" ? "Photo" : "Document"}{mirror ? ` · ${mirror.status === "synced" ? "Copied to Microsoft" : mirror.status === "syncing" ? "Copy in progress" : mirror.status === "unknown" ? "Checking previous copy required" : "Copy needs attention"}` : ""}</p>
        {mirror?.lastError && <p className="mt-1 text-xs text-destructive">{mirror.lastError}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {storedUrl && <Button asChild variant="outline" size="sm"><a href={storedUrl} target="_blank" rel="noopener noreferrer">Open file</a></Button>}
        {microsoftUrl && <Button asChild variant="outline" size="sm"><a href={microsoftUrl} target="_blank" rel="noopener noreferrer">Open in Microsoft</a></Button>}
        {canSync && data?.microsoft.connected && data.microsoft.targetReady && mirror?.status !== "synced" && <Button variant="outline" size="sm" disabled={Boolean(busyId) || isUploading || mirror?.status === "syncing"} onClick={() => void sync(sourceType, source.id)}>{busyId === `${sourceType}:${source.id}` ? "Copying…" : mirror?.status === "unknown" ? "Check previous copy" : mirror?.status === "error" ? "Retry copy" : "Copy to Microsoft"}</Button>}
      </div>
    </li>;
  }
  return <Card data-training-id="job-files">
    <CardHeader><CardTitle>Job files</CardTitle><CardDescription>Keep documents with the job and copy selected files to your company’s Microsoft folder.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <input aria-label="Job document" ref={input} type="file" className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (!file) return; setError("");
          void uploadFile(file, "job-document", jobId, async objectPath => {
            await operation(`${path}/documents`, "POST", { objectPath, idempotencyKey: crypto.randomUUID() }); await refetch();
          });
        }} />
        <Button variant="outline" disabled={isUploading || Boolean(busyId) || !data} onClick={() => input.current?.click()}>{isUploading ? "Uploading…" : "Upload document"}</Button>
        <Button variant="outline" disabled={Boolean(busyId)} onClick={() => void refetch()}>Refresh files</Button>
        {folderUrl && <Button asChild variant="outline"><a href={folderUrl} target="_blank" rel="noopener noreferrer">Open Microsoft job folder</a></Button>}
      </div>
      <p className="text-xs text-muted-foreground">Files stay private to this company. Uploads can be up to 15 MB. Microsoft copies are created only when you choose Copy to Microsoft.</p>
      {data && !data.microsoft.targetReady && <p className="text-sm text-muted-foreground">An owner can connect Microsoft files and select a folder in Settings.</p>}
      {isLoading && <p role="status">Loading job files…</p>}
      {isError && <p role="alert">Job files could not be loaded. Use Refresh files to retry.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {data && <ul className="space-y-2">{data.documents.map(item => row("document", item))}{data.photos.map(item => row("photo", item))}</ul>}
      {data && !data.documents.length && !data.photos.length && <p className="text-sm text-muted-foreground">No documents or photos have been added to this job.</p>}
    </CardContent>
  </Card>;
}
