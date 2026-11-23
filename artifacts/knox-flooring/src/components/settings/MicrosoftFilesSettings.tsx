import { useRef, useState } from "react";
import { useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { operation, useOperation } from "@/lib/operations";
import { microsoftFileUrl } from "@/lib/microsoft-file-links";
import { MicrosoftFilesFolderBrowser } from "./MicrosoftFilesFolderBrowser";

interface FilesStatus {
  configured: boolean;
  status: "not_configured" | "disconnected" | "connected" | "reconnect_required";
  accountEmail: string | null;
  appClientId: string | null;
  browserAvailable?:boolean;
  approvedRootConfigured?:boolean;
  targetLocked?:boolean;
  setupError?:string|null;
  target: { driveId: string; folderId: string; name: string; webUrl: string | null; verifiedAt: string } | null;
}

export function MicrosoftFilesSettings() {
  const { allowed, data, isLoading, isError, refetch } = useOperation<FilesStatus>("/microsoft/files/status", ["owner"]);
  const [driveId, setDriveId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const callback = new URLSearchParams(useSearch()).get("microsoftFiles");
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Microsoft files could not be updated."); }
    finally { locked.current = false; setBusy(false); }
  }
  if (!allowed) return null;
  const connected = data?.status === "connected";
  const folderUrl = microsoftFileUrl(data?.target?.webUrl);
  return <Card>
    <CardHeader><CardTitle>Microsoft job files</CardTitle><CardDescription>Copy selected job documents and photos into a company SharePoint or OneDrive folder.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {isLoading && <p role="status">Checking Microsoft files…</p>}
      {isError && <p role="alert">Microsoft files status is unavailable. <button className="underline" onClick={() => void refetch()}>Retry</button></p>}
      {data && !data.configured && <p className="text-sm text-muted-foreground">Microsoft job files are not available for this company yet.</p>}
      {data?.configured && <>
        <p className="text-sm">{connected ? `Connected as ${data.accountEmail ?? "your Microsoft account"}.` : data.status === "reconnect_required" ? "Reconnect your work or school Microsoft account to continue." : "Connect a work or school Microsoft account."}</p>
        <div className="flex flex-wrap gap-2">
          {!connected && <Button disabled={busy} onClick={() => void run(async () => {
            const result = await operation<{ authorizationUrl: string }>("/microsoft/files/connect", "POST", {});
            const url = new URL(result.authorizationUrl);
            if (url.protocol !== "https:" || url.hostname !== "login.microsoftonline.com" || url.username || url.password || url.port) throw new Error("Microsoft sign-in is unavailable. Please try again.");
            window.location.assign(url.href);
          })}>Connect Microsoft files</Button>}
          {connected && <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
            await operation("/microsoft/files/disconnect", "POST", {}); await refetch();
            setMessage("Microsoft files disconnected. Copies already saved in Microsoft remain there.");
          })}>Disconnect Microsoft files</Button>}
        </div>
        {connected && <div className="space-y-3 rounded-md border p-3 text-sm">
          {data.setupError&&<p role="alert" className="text-destructive">{data.setupError}</p>}
          {data.target ? <p>Selected folder: {folderUrl ? <a className="underline" href={folderUrl} target="_blank" rel="noopener noreferrer">{data.target.name}</a> : data.target.name}</p> : <p>Choose the folder where job folders should be created.</p>}
          <p className="text-muted-foreground">Your Microsoft administrator must give Catalyst Works write access to this specific folder. Connecting your account alone does not grant folder access.</p>
          {(data.browserAvailable??Boolean(data.target))&&<MicrosoftFilesFolderBrowser key={`${data.appClientId}:${data.accountEmail}:${data.target?.folderId??""}`} disabled={busy} targetLocked={data.targetLocked} onSelected={async()=>{await refetch();setMessage("Folder access verified. Use a job’s Files panel to copy individual documents and photos.");}}/>}
          {!data.browserAvailable&&!data.target&&<p className="text-muted-foreground">Your administrator needs to approve the company folder before browsing becomes available.</p>}
          {!data.approvedRootConfigured&&!data.targetLocked&&<details className="space-y-3"><summary className="cursor-pointer">Administrator folder setup</summary>
          {data.appClientId && <p className="break-all text-xs text-muted-foreground">Application ID: {data.appClientId}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">Drive ID<Input value={driveId} maxLength={512} disabled={busy} onChange={event => setDriveId(event.target.value)} autoComplete="off" /></label>
            <label className="space-y-1">Folder ID<Input value={folderId} maxLength={512} disabled={busy} onChange={event => setFolderId(event.target.value)} autoComplete="off" /></label>
          </div>
          <Button variant="outline" disabled={busy || !driveId.trim() || !folderId.trim()} onClick={() => void run(async () => {
            await operation("/microsoft/files/target", "PUT", { driveId: driveId.trim(), folderId: folderId.trim() });
            await refetch(); setDriveId(""); setFolderId(""); setMessage("Folder access verified. Use a job’s Files panel to copy individual documents and photos.");
          })}>{busy ? "Checking folder…" : "Verify and use folder"}</Button>
          </details>}
        </div>}
      </>}
      {(error || (callback && callback !== "connected" ? "Microsoft files authorization did not finish. Connect again to retry." : "")) && <p role="alert" className="text-sm text-destructive">{error || "Microsoft files authorization did not finish. Connect again to retry."}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </CardContent>
  </Card>;
}
