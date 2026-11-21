import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { barcodeModuleMillimeters, code128 } from "@/lib/warehouse-labels";

const svgNamespace = "http://www.w3.org/2000/svg";

export function StockPieceLabel({
  label,
  code = label,
  title = "Stock label",
  fields,
  onClose,
}: {
  label: string;
  code?: string;
  title?: string;
  fields: ReadonlyArray<readonly [string, string]>;
  onClose(): void;
}) {
  const [error, setError] = useState("");
  const barcode = code128(code);
  const width = barcode ? barcode.width * barcodeModuleMillimeters : 0;
  function print() {
    if (!barcode) return;
    setError("");
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("Allow pop-ups for Catalyst Works and select Print again.");
      return;
    }
    printWindow.opener = null;
    const page = printWindow.document;
    page.title = `${title} · ${label}`;
    const styles = page.createElement("style");
    styles.textContent = `body{margin:3mm;color:#111;font:11pt system-ui,sans-serif}h1{margin:0 0 2mm;font-size:17pt;overflow-wrap:anywhere}main{padding:2mm;border:1px solid;width:${Math.max(62, width)}mm;break-inside:avoid}p{margin:1mm 0;overflow-wrap:anywhere}code{display:block;margin-bottom:2mm;font:9pt monospace;overflow-wrap:anywhere}button{margin-top:4mm}@media print{body{margin:0}button{display:none}}@page{margin:3mm;${width > 180 ? "size:landscape;" : ""}}`;
    page.head.append(styles);
    const card = page.createElement("main");
    const heading = page.createElement("h1");
    heading.textContent = label;
    card.append(heading);
    const symbol = page.createElementNS(svgNamespace, "svg");
    symbol.setAttribute("viewBox", `0 0 ${barcode.width} ${barcode.height}`);
    symbol.setAttribute("width", `${width}mm`);
    symbol.setAttribute(
      "height",
      `${barcode.height * barcodeModuleMillimeters}mm`,
    );
    symbol.setAttribute("aria-label", `Code 128 barcode for ${code}`);
    symbol.setAttribute("shape-rendering", "crispEdges");
    const ink = page.createElementNS(svgNamespace, "path");
    ink.setAttribute("d", barcode.path);
    ink.setAttribute("fill", "black");
    symbol.append(ink);
    const humanCode = page.createElement("code");
    humanCode.textContent = code;
    card.append(symbol, humanCode);
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
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Print at actual size to preserve the barcode dimensions.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-white p-4 text-black">
          <p className="break-all text-xl font-semibold">{label}</p>
          {barcode && (
            <div className="my-3">
              <svg
                role="img"
                aria-label={`Code 128 barcode for ${code}`}
                viewBox={`0 0 ${barcode.width} ${barcode.height}`}
                className="h-auto w-full"
                shapeRendering="crispEdges"
              >
                <path d={barcode.path} fill="black" />
              </svg>
              {code !== label && (
                <p className="break-all font-mono text-xs">{code}</p>
              )}
            </div>
          )}
          {width > 95 && (
            <p className="text-xs text-muted-foreground">
              Use paper at least {Math.ceil(width + 10)} mm wide for this label.
            </p>
          )}
          <dl className="mt-3 space-y-2 text-sm">
            {fields.map(([name, value]) => (
              <div
                className="grid grid-cols-[minmax(5rem,1fr)_2fr] gap-2"
                key={name}
              >
                <dt className="font-medium">{name}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        {(error || !barcode) && (
          <p role="alert" className="text-sm text-destructive">
            {error || "This code cannot be printed as a barcode."}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={!barcode} onClick={print}>
            Print
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
