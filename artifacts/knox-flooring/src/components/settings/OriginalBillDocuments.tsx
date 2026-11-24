import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { operation } from "@/lib/operations";
import {
  billOriginalDownload,
  billOriginalMaxBytes,
  billOriginalTypes,
  coverageRejected,
  uploadBillOriginal,
  type BillDocument,
} from "@/lib/receipt-bill-coverage";

export function OriginalBillDocuments({
  billId,
  documents,
  onSaved,
}: {
  billId: string;
  documents: BillDocument[];
  onSaved(): Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const claim = useRef<{
    requestKey: string;
    objectPath: string | null;
  } | null>(null);
  function choose(next: File | null) {
    setError("");
    setNotice("");
    setFile(null);
    setConfirmed(false);
    claim.current = null;
    if (
      next &&
      (!next.size ||
        next.size > billOriginalMaxBytes ||
        !billOriginalTypes.has(next.type))
    ) {
      setError("Choose a PDF, JPEG or PNG up to 10 MiB.");
      return;
    }
    setFile(next);
    if (next)
      claim.current = { requestKey: crypto.randomUUID(), objectPath: null };
  }
  async function save() {
    if (!file || !confirmed || !claim.current || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let claiming = false;
    try {
      if (!claim.current.objectPath)
        claim.current.objectPath = (
          await uploadBillOriginal(file, billId)
        ).objectPath;
      claiming = true;
      await operation(
        `/quickbooks/vendor-bills/${encodeURIComponent(billId)}/documents`,
        "POST",
        {
          objectPath: claim.current.objectPath,
          requestKey: claim.current.requestKey,
        },
      );
      claim.current = null;
      setFile(null);
      setConfirmed(false);
      setUncertain(false);
      if (input.current) input.current.value = "";
      setNotice("Original bill file saved privately in Works.");
      await onSaved();
    } catch (failure) {
      if (claiming && (!coverageRejected(failure) || uncertain)) {
        setUncertain(true);
        setError(
          "The saved-file confirmation is unknown. Retry the same confirmation; the selected upload and request reference are retained. A rejected retry does not establish whether the original file claim was saved.",
        );
      } else {
        setUncertain(false);
        setError(
          failure instanceof Error
            ? failure.message
            : "The original file could not be saved.",
        );
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Original supplier bill files"
      className="space-y-3 rounded border p-3"
    >
      <h4 className="font-semibold">Original supplier bill files</h4>
      <p className="text-sm text-muted-foreground">
        Optional private evidence in Works. Saving a file does not attach it to
        QuickBooks or confirm payment, receiving, or coverage.
      </p>
      {documents.length ? (
        <ul className="space-y-2">
          {documents.map((doc) => {
            const href = billOriginalDownload(doc, billId);
            return (
              <li key={doc.id} className="break-all text-sm">
                <p>
                  {doc.fileName} · {doc.size.toLocaleString()} bytes
                </p>
                <p className="text-xs text-muted-foreground">
                  SHA-256: {doc.sha256}
                </p>
                {href ? (
                  <a href={href} download className="text-primary underline">
                    Download original bill
                  </a>
                ) : (
                  <p>Download unavailable; refresh saved evidence.</p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm">No original bill files saved.</p>
      )}
      <label className="block text-sm">
        Original bill PDF or image
        <input
          ref={input}
          className="block max-w-full"
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          disabled={busy || uncertain}
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />
      </label>
      {file && <p className="break-all text-sm">Selected: {file.name}</p>}
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!file || busy || uncertain}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm this is the original evidence for this supplier bill.
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={!file || !confirmed || busy}
        onClick={() => void save()}
      >
        {busy
          ? "Saving original…"
          : uncertain
            ? "Retry original confirmation"
            : "Save original bill file"}
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
