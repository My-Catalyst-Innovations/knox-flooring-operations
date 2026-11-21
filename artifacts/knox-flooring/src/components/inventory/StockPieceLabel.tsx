import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function StockPieceLabel({ label, fields, onClose }: {
  label: string; fields: ReadonlyArray<readonly [string, string]>; onClose(): void;
}) {
  const [error, setError] = useState("");
  function print() {
    setError("");
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("Allow pop-ups for Catalyst Works and select Print again.");
      return;
    }
    printWindow.opener = null;
    const page = printWindow.document;
    page.title = `Stock label · ${label}`;
    const styles = page.createElement("style");
    styles.textContent = "body{margin:12mm;color:#111;font:12pt system-ui,sans-serif}h1{margin:0 0 4mm;font-size:20pt;overflow-wrap:anywhere}main{padding:4mm;border:1px solid;max-width:90mm;break-inside:avoid}p{margin:2mm 0;overflow-wrap:anywhere}button{margin-top:4mm}@media print{button{display:none}}";
    page.head.append(styles);
    const card = page.createElement("main");
    const heading = page.createElement("h1");
    heading.textContent = label;
    card.append(heading);
    for (const [key, value] of fields) {
      const line = page.createElement("p");
      const title = page.createElement("strong");
      title.textContent = key;
      line.append(title, `  ${value}`);
      card.append(line);
    }
    const button = page.createElement("button");
    button.textContent = "Print";
    button.addEventListener("click", () => printWindow.print());
    page.body.append(card, button);
    printWindow.focus();
    printWindow.print();
  }
  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    <DialogContent>
      <DialogHeader><DialogTitle>Stock label</DialogTitle><DialogDescription>Print and attach this label to the measured piece.</DialogDescription></DialogHeader>
      <div className="rounded-md border bg-white p-4 text-black">
        <p className="break-all text-xl font-semibold">{label}</p>
        <dl className="mt-3 space-y-2 text-sm">
          {fields.map(([name, value]) => <div className="grid grid-cols-[minmax(5rem,1fr)_2fr] gap-2" key={name}>
            <dt className="font-medium">{name}</dt><dd className="break-words">{value}</dd>
          </div>)}
        </dl>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Close</Button><Button onClick={print}>Print</Button></div>
    </DialogContent>
  </Dialog>;
}
