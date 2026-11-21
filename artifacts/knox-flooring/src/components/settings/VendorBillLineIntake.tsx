import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { billIntakeDollars, billIntakeLimit, billLineFields, billLineTemplate, previewBillIntake, type VendorBillLine } from "@/lib/vendor-bill-intake";
import type { readBillDocument } from "@/lib/vendor-bill-document-reader";

export function VendorBillLineIntake({ onApply }: { onApply(lines: VendorBillLine[]): void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const readVersion = useRef(0);
  const readingDocument = useRef<AbortController | null>(null);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof previewBillIntake>>();
  const [documentPreview, setDocumentPreview] = useState<Awaited<ReturnType<typeof readBillDocument>>>();
  const [reviewedDocument, setReviewedDocument] = useState(false);
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => () => { readVersion.current++; readingDocument.current?.abort(); }, []);

  function editSource(next: string) {
    readVersion.current++;
    readingDocument.current?.abort();
    readingDocument.current = null;
    setReading(false);
    setStatus("");
    setSource(next);
    setPreview(undefined);
    setDocumentPreview(undefined);
    setReviewedDocument(false);
    setFileError("");
  }

  async function load(file: File) {
    editSource("");
    const version = readVersion.current;
    if (file.size > billIntakeLimit) {
      setFileError("Choose a bill-line file under 128 KB.");
      return;
    }
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      setFileError("Copy the line table from the PDF as comma- or tab-separated text, or export a CSV.");
      return;
    }
    setReading(true);
    try {
      const contents = await file.text();
      if (version !== readVersion.current) return;
      setSource(contents);
      setPreview(previewBillIntake(contents));
    } catch {
      if (version === readVersion.current) setFileError("The file could not be read. Choose it again or paste its table.");
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  }

  async function loadDocument(file: File) {
    editSource("");
    const version = readVersion.current;
    const controller = new AbortController();
    readingDocument.current = controller;
    setReading(true);
    setStatus("Opening invoice document…");
    try {
      const { readBillDocument } = await import("@/lib/vendor-bill-document-reader");
      if (version !== readVersion.current) return;
      const imported = await readBillDocument(file, {
        signal: controller.signal,
        status: (message) => { if (version === readVersion.current) setStatus(message); },
      });
      if (version !== readVersion.current) return;
      setDocumentPreview(imported);
      setPreview(imported.preview);
    } catch (error) {
      if (version === readVersion.current) setFileError(error instanceof Error ? error.message : "The invoice document could not be read. Use CSV or manual entry.");
    } finally {
      if (version === readVersion.current) {
        readingDocument.current = null;
        setReading(false);
        setStatus("");
      }
    }
  }

  const valid = preview && !preview.problems.length;
  return (
    <details ref={details} className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">Import bill lines</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted-foreground">
          Import a PDF or scan with a clear item table, use the four CSV template columns, or paste a comma- or tab-separated table.
        </p>
        <label className="block space-y-1 text-sm font-medium">
          Invoice PDF or scan
          <Input type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void loadDocument(file);
          }} />
          <span className="block text-xs font-normal text-muted-foreground">PDF, PNG or JPEG up to 10 MB. Documents are read in your browser.</span>
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-0 flex-1 space-y-1 text-sm font-medium">
            Bill line CSV or text file
            <Input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void load(file);
            }} />
          </label>
          <a className="pb-2 text-sm text-primary underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(billLineTemplate)}`} download="supplier-bill-lines.csv">Download CSV template</a>
        </div>
        <label className="block space-y-1 text-sm font-medium">
          Paste bill line table
          <Textarea rows={4} value={source} onChange={(event) => editSource(event.target.value)} className="font-mono text-xs" />
        </label>
        <Button type="button" variant="outline" size="sm" disabled={!source.trim() || reading} onClick={() => setPreview(previewBillIntake(source))}>Check imported lines</Button>
        {reading && <div className="flex items-center gap-2">
          <p role="status" className="text-sm text-muted-foreground">{status || "Reading bill lines…"}</p>
          {status && <Button type="button" variant="ghost" size="sm" onClick={() => editSource("")}>Cancel reading</Button>}
        </div>}
        {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
        {preview && preview.problems.length > 0 && (
          <ul role="alert" className="max-h-48 space-y-1 overflow-y-auto text-sm text-destructive">
            {preview.problems.map((problem, index) => <li key={index}>{problem}</li>)}
          </ul>
        )}
        {valid && (
          <div className="space-y-2">
            <div className="max-h-64 overflow-auto rounded-md border">
              <table className="min-w-full text-left text-sm">
                <caption className="sr-only">Imported bill lines</caption>
                <thead><tr className="border-b bg-muted/30">
                  <th scope="col" className="p-2">{documentPreview ? "Source" : "File line"}</th>
                  {billLineFields.map(([field, label]) => <th key={field} scope="col" className="p-2">{label}</th>)}
                  <th scope="col" className="p-2">Amount</th>
                </tr></thead>
                <tbody className="divide-y">
                  {preview.rows.map(({ rowNumber, line, amountCents }, index) => <tr key={rowNumber}>
                    <td className="p-2 tabular-nums">{documentPreview ? `Page ${documentPreview.sources[index].page}, row ${documentPreview.sources[index].row}` : rowNumber}</td>
                    {billLineFields.map(([field]) => <td key={field} className="p-2 [overflow-wrap:anywhere]">{line[field]}</td>)}
                    <td className="p-2 tabular-nums">{billIntakeDollars(amountCents)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            <p className="text-sm">Imported merchandise total <strong>{billIntakeDollars(preview.totalCents)}</strong></p>
            <p className="text-sm text-muted-foreground">Using these lines replaces the current item rows. Enter the source bill total from the original document.</p>
            {documentPreview && <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={reviewedDocument} onChange={(event) => setReviewedDocument(event.target.checked)} />
              <span>{documentPreview.usedOcr ? "I checked each scanned line against the original invoice." : "I checked each extracted line against the original invoice."}</span>
            </label>}
            <Button type="button" size="sm" disabled={!!documentPreview && !reviewedDocument} onClick={() => {
              onApply(preview.rows.map((row) => row.line));
              editSource("");
              if (details.current) {
                details.current.open = false;
                details.current.querySelector("summary")?.focus();
              }
            }}>Use {preview.rows.length} {preview.rows.length === 1 ? "line" : "lines"}</Button>
          </div>
        )}
      </div>
    </details>
  );
}
