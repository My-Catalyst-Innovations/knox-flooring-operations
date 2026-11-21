import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { billIntakeDollars, billIntakeLimit, billLineFields, billLineTemplate, previewBillIntake, type VendorBillLine } from "@/lib/vendor-bill-intake";

export function VendorBillLineIntake({ onApply }: { onApply(lines: VendorBillLine[]): void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const readVersion = useRef(0);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof previewBillIntake>>();
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);

  function editSource(next: string) {
    readVersion.current++;
    setReading(false);
    setSource(next);
    setPreview(undefined);
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

  const valid = preview && !preview.problems.length;
  return (
    <details ref={details} className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">Import bill lines</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted-foreground">
          Use the four template columns. You can also paste a copied PDF table if it retains comma or tab separators.
        </p>
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
        {reading && <p role="status" className="text-sm text-muted-foreground">Reading bill lines…</p>}
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
                  <th scope="col" className="p-2">File line</th>
                  {billLineFields.map(([field, label]) => <th key={field} scope="col" className="p-2">{label}</th>)}
                  <th scope="col" className="p-2">Amount</th>
                </tr></thead>
                <tbody className="divide-y">
                  {preview.rows.map(({ rowNumber, line, amountCents }) => <tr key={rowNumber}>
                    <td className="p-2 tabular-nums">{rowNumber}</td>
                    {billLineFields.map(([field]) => <td key={field} className="p-2 [overflow-wrap:anywhere]">{line[field]}</td>)}
                    <td className="p-2 tabular-nums">{billIntakeDollars(amountCents)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            <p className="text-sm">Imported merchandise total <strong>{billIntakeDollars(preview.totalCents)}</strong></p>
            <p className="text-sm text-muted-foreground">Using these lines replaces the current item rows. Enter the source bill total from the original document.</p>
            <Button type="button" size="sm" onClick={() => {
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
