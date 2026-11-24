import { useRef, useState } from "react";
import { useAuth } from "@/contexts/auth";
import { operation } from "@/lib/operations";
import {
  legacyDocumentDownload,
  legacyOriginalMaxBytes,
  legacyOriginalTypes,
  uploadLegacyOriginal,
  type LegacyArchiveDocument,
} from "@/lib/legacy-history";
import { Button } from "@/components/ui/button";

export function LegacyArchiveFiles({
  recordId,
  documents,
  onSaved,
}: {
  recordId: string;
  documents: LegacyArchiveDocument[];
  onSaved(): void;
}) {
  const { user } = useAuth();
  const allowed = user?.role === "owner" && !user.previewRole;
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const claim = useRef<{
    requestKey: string;
    objectPath: string | null;
  } | null>(null);
  if (!allowed) return null;

  function choose(next: File | null) {
    setError("");
    setNotice("");
    setConfirmed(false);
    claim.current = null;
    if (
      next &&
      (!next.size ||
        next.size > legacyOriginalMaxBytes ||
        !legacyOriginalTypes.has(next.type))
    ) {
      setFile(null);
      setError("Choose a PDF, JPEG, PNG, WebP or GIF up to 15 MiB.");
      return;
    }
    setFile(next);
    if (next)
      claim.current = { requestKey: crypto.randomUUID(), objectPath: null };
  }
  async function append() {
    if (!allowed || !file || !confirmed || !claim.current || pending.current)
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!claim.current.objectPath)
        claim.current.objectPath = (
          await uploadLegacyOriginal(file, recordId)
        ).objectPath;
      await operation(
        `/legacy-history/${encodeURIComponent(recordId)}/documents`,
        "POST",
        {
          objectPath: claim.current.objectPath,
          requestKey: claim.current.requestKey,
          confirmOriginal: true,
        },
      );
      setFile(null);
      setConfirmed(false);
      claim.current = null;
      if (input.current) input.current.value = "";
      setNotice("Original file saved with this historical record.");
      onSaved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The original file could not be saved. Retry the same selected file to check its saved claim.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Historical original files"
      className="space-y-3 rounded-lg border p-4"
    >
      <h2 className="font-semibold">Historical original files</h2>
      <p className="text-sm text-muted-foreground">
        Private downloads only. Files are retained as historical evidence and
        are never published, rendered inline, copied to Microsoft or attached to
        an active job.
      </p>
      {documents.length ? (
        <ul className="space-y-2">
          {documents.map((document) => {
            const url =
              document.recordId === recordId
                ? legacyDocumentDownload(document)
                : null;
            return (
              <li
                key={document.id}
                className="space-y-1 rounded border p-3 text-sm"
              >
                <p className="break-all font-medium">{document.name}</p>
                <p>
                  {document.size.toLocaleString()} bytes · Saved{" "}
                  {new Date(document.createdAt).toLocaleString()}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  SHA-256: {document.sha256}
                </p>
                {url ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={url} download>
                      Download original
                    </a>
                  </Button>
                ) : (
                  <p className="text-destructive">
                    Download unavailable. Refresh this record before continuing.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No original files are saved for this historical record.
        </p>
      )}
      <label className="block space-y-1 text-sm">
        Choose an original file
        <input
          ref={input}
          className="block max-w-full"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/gif"
          disabled={busy}
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />
      </label>
      {file && (
        <p className="break-all text-sm">
          Selected: {file.name} · {file.size.toLocaleString()} bytes
        </p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || !file}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm this is an original file for this selected historical record.
        It will be saved privately in the archive.
      </label>
      <Button
        disabled={busy || !file || !confirmed}
        onClick={() => void append()}
      >
        {busy ? "Saving original…" : "Save original file"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
