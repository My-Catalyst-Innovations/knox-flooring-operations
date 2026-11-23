import { useRef, useState, type ChangeEvent } from "react";
import {
  catalogImportHeaders,
  catalogImportMaxBytes,
  catalogImportMaxRows,
  type CatalogImportPreview,
} from "@workspace/domain";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { operation, useRefreshOperations } from "@/lib/operations";

const importPath = "/products/catalog-import";
const template = `data:text/csv;charset=utf-8,${encodeURIComponent(`${catalogImportHeaders.join(",")}\r\n`)}`;
const formatPrice = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
}).format;
const formatCount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 })
  .format;

function CatalogImportForm({ setBusy }: { setBusy(busy: boolean): void }) {
  const refresh = useRefreshOperations();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<CatalogImportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<number | null>(null);
  const inputVersion = useRef(0);
  const rows = preview?.rows ?? [];
  const rowsWithErrors = rows.filter((row) => row.status === "error").length;
  const existing = new Set(
    rows
      .filter((row) => row.status === "existing")
      .map((row) => row.sku.trim().toLowerCase()),
  ).size;

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The catalog request failed. Try again.",
      );
    } finally {
      setPending(false);
      setBusy(false);
    }
  };

  const requestPreview = async (
    data: string,
    version = inputVersion.current,
  ) => {
    if (!data.trim())
      throw new Error("Enter CSV text with a header and product rows.");
    if (new TextEncoder().encode(data).length > catalogImportMaxBytes)
      throw new Error(
        `Use CSV text of ${catalogImportMaxBytes / 1_000} KB or less.`,
      );
    const result = await operation<CatalogImportPreview>(
      `${importPath}/preview`,
      "POST",
      {
        csv: data,
      },
    );
    if (inputVersion.current === version) setPreview(result);
  };

  const editCsv = (data: string) => {
    inputVersion.current++;
    setCsv(data);
    setPreview(null);
    setCreated(null);
    setError("");
    return inputVersion.current;
  };

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    const version = editCsv("");
    if (!file) return;
    if (file.size > catalogImportMaxBytes) {
      setError(
        `Choose a CSV file of ${catalogImportMaxBytes / 1_000} KB or less.`,
      );
      return;
    }
    void run(async () => {
      const data = await file.text();
      if (inputVersion.current !== version) return;
      if (!data.trim())
        throw new Error("The file is empty. Choose a CSV with product rows.");
      setCsv(data);
      await requestPreview(data, version);
    });
  };

  const confirm = () => {
    if (
      !preview ||
      pending ||
      rowsWithErrors ||
      preview.errors.length ||
      !preview.newProducts
    )
      return;
    const { previewKey } = preview;
    setPreview(null);
    void run(async () => {
      const result = await operation<{ created: number }>(importPath, "POST", {
        csv,
        previewKey,
      });
      setCreated(result.created);
      await refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <a href={template} download="inventory-catalog-template.csv">
            Download CSV template
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">
          Up to {catalogImportMaxRows.toLocaleString()} rows per file
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Enter an internal SKU or use the source item ID to generate one. Use the
        category and unit shown in Inventory. Repeat the same item on separate
        rows when you have opening counts at two warehouses.
      </p>
      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor="catalog-import-file">
          Catalog CSV
        </label>
        <Input
          id="catalog-import-file"
          type="file"
          accept=".csv,text/csv"
          disabled={pending}
          onChange={readFile}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="catalog-import-paste" className="text-sm font-medium">
          Paste catalog CSV
        </label>
        <Textarea
          id="catalog-import-paste"
          rows={5}
          className="font-mono text-xs"
          value={csv}
          disabled={pending}
          placeholder={catalogImportHeaders.join(",")}
          aria-describedby="catalog-import-paste-help"
          onChange={(event) => editCsv(event.target.value)}
        />
        <p
          id="catalog-import-paste-help"
          className="text-xs text-muted-foreground"
        >
          Paste the header and product rows from a CSV, or copy the file text.
          Keep leading zeros in SKU values. For a catalog-only import, leave
          warehouse blank and use zero opening stock. The same{" "}
          {catalogImportMaxRows.toLocaleString()}-row limit applies.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={pending || !csv.trim()}
          onClick={() => void run(() => requestPreview(csv))}
        >
          Preview pasted CSV
        </Button>
      </div>
      {pending && (
        <p className="text-sm text-muted-foreground" role="status">
          Processing catalog…
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {created !== null && (
        <p className="text-sm" role="status">
          Imported {created} {created === 1 ? "product" : "products"} into
          Inventory.
        </p>
      )}
      {preview?.errors.map((issue) => (
        <p key={issue} className="text-sm text-destructive" role="alert">
          {issue}
        </p>
      ))}
      {rows.length > 0 && (
        <>
          <p className="text-sm" role="status">
            {preview?.newProducts} new · {existing} existing · {rowsWithErrors}{" "}
            {rowsWithErrors === 1 ? "row needs" : "rows need"} review
          </p>
          <div className="max-h-72 overflow-auto rounded-md border">
            <table
              className="w-full text-left text-sm"
              aria-label="Catalog import preview"
            >
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Opening count</th>
                  <th className="px-3 py-2">Cost / Sale</th>
                  <th className="px-3 py-2">Review</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.line} className="border-t align-top">
                    <td className="px-3 py-2">{row.line}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium">{row.sku || "—"}</span>
                      <br />
                      {row.name}
                    </td>
                    <td className="px-3 py-2">
                      {row.warehouse || "—"}
                      {row.warehouse && row.onHand !== null && (
                        <>
                          <br />
                          {formatCount(row.onHand)} {row.unit}
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {row.unitCost === null ? "—" : formatPrice(row.unitCost)}{" "}
                      /{" "}
                      {row.salePrice === null
                        ? "—"
                        : formatPrice(row.salePrice)}
                    </td>
                    <td
                      className={`px-3 py-2 ${row.status === "error" ? "text-destructive" : ""}`}
                    >
                      {row.message ?? "Ready to import"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={confirm}
              disabled={pending || rowsWithErrors > 0 || !preview?.newProducts}
            >
              Import {preview?.newProducts ?? 0}{" "}
              {preview?.newProducts === 1 ? "product" : "products"}
            </Button>
          </div>
        </>
      )}
      {error && csv && !preview && (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => void run(() => requestPreview(csv))}
        >
          Preview again
        </Button>
      )}
    </div>
  );
}

export function CatalogImportDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">Import products</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import products</DialogTitle>
          <DialogDescription>
            Preview new internal SKUs and opening stock before saving them to
            Inventory.
          </DialogDescription>
        </DialogHeader>
        {open && <CatalogImportForm setBusy={setBusy} />}
      </DialogContent>
    </Dialog>
  );
}
