import { useMemo, useRef, useState, type ChangeEvent } from "react";
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
import { useAuth } from "@/contexts/auth";
import { operation, useOperation } from "@/lib/operations";
import {
  previewSupplierImport,
  type SupplierCrosswalkAlias,
  type SupplierImportProduct,
  type SupplierImportRow,
} from "@/lib/supplier-import";

const template =
  "supplier,supplier_sku,internal_sku,manufacturer_part_number,unit,unit_cost,stock_units_per_buy_unit\r\n";
const maxFileSize = 2 * 1024 * 1024;
const maxApprovalRows = 2500;
const maxApprovalBytes = 1024 * 1024;
const pageSize = 50;
const crosswalkPath = "/inventory/supplier-crosswalk";

type ApprovalResult = {
  aliasesAdded: number;
  pricesAdded: number;
  alreadyApproved: number;
};

const statusLabels: Record<SupplierImportRow["status"], string> = {
  matched: "Matched",
  unmatched: "No match",
  ambiguous: "Multiple matches",
  archived: "Archived product",
  "unit-mismatch": "Unit conflict",
  duplicate: "Duplicate row",
  invalid: "Invalid row",
};

function needsReview(row: SupplierImportRow) {
  return (
    row.status !== "matched" ||
    row.priceDifference === "higher" ||
    row.priceDifference === "lower"
  );
}

const normalizedSku = (value: string) => value.trim().toLowerCase();

function CatalogSkuPicker({
  row,
  products,
  onChoose,
  onCancel,
}: {
  row: SupplierImportRow;
  products: readonly SupplierImportProduct[];
  onChoose: (sku: string) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState("");
  const term = normalizedSku(search);
  const matches = products.filter(
    (product) =>
      normalizedSku(product.unit) === normalizedSku(row.unit) &&
      (normalizedSku(product.name).includes(term) ||
        normalizedSku(product.sku).includes(term)),
  );
  return (
    <div className="space-y-2 rounded-md border p-2 sm:col-span-2 lg:col-span-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1 font-medium">
          Search catalog for {row.supplierSku}
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Product name or internal SKU"
          />
        </label>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Close product picker
        </Button>
      </div>
      {matches.length > 0 ? (
        <ul
          aria-label={`Catalog matches for ${row.supplierSku}`}
          className="max-h-40 space-y-1 overflow-y-auto"
        >
          {matches.slice(0, 50).map((product) => (
            <li key={product.id}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal text-left"
                onClick={() => onChoose(product.sku.trim())}
              >
                {product.name} · {product.sku}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          No active products with a unique SKU match this unit and search.
        </p>
      )}
      {matches.length > 50 && (
        <p className="text-muted-foreground">
          Showing 50 products. Search by name or SKU to narrow the list.
        </p>
      )}
    </div>
  );
}

function SupplierImportContent({
  products,
}: {
  products: readonly SupplierImportProduct[];
}) {
  const { user } = useAuth();
  const canApprove = user?.role === "owner" && !user.previewRole;
  const crosswalk = useOperation<SupplierCrosswalkAlias[]>(crosswalkPath, [
    "owner",
    "operations",
  ]);
  const [csv, setCsv] = useState<string | null>(null);
  const [draftCsv, setDraftCsv] = useState("");
  const inputVersion = useRef(0);
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [effectiveOn, setEffectiveOn] = useState("");
  const [source, setSource] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [approved, setApproved] = useState<ApprovalResult | null>(null);
  const [approvedLines, setApprovedLines] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const [onlyReview, setOnlyReview] = useState(false);
  const [page, setPage] = useState(0);
  const [chosenSkus, setChosenSkus] = useState<ReadonlyMap<number, string>>(
    new Map(),
  );
  const [pickerLine, setPickerLine] = useState<number | null>(null);
  const selectableProducts = useMemo(() => {
    const occurrences = new Map<string, number>();
    for (const product of products) {
      const sku = normalizedSku(product.sku);
      occurrences.set(sku, (occurrences.get(sku) ?? 0) + 1);
    }
    return products.filter((product) => {
      const sku = normalizedSku(product.sku);
      return product.active && sku && occurrences.get(sku) === 1;
    });
  }, [products]);
  const preview = useMemo(
    () =>
      csv === null
        ? null
        : previewSupplierImport(csv, products, crosswalk.data, chosenSkus),
    [csv, products, crosswalk.data, chosenSkus],
  );
  const rows = preview?.rows ?? [];
  const reviewRows = rows.filter(
    (row) =>
      !approvedLines.has(row.line) && (needsReview(row) || !!row.chosenSku),
  );
  const approvable = rows.filter(
    (row) =>
      row.status === "matched" && row.product && !approvedLines.has(row.line),
  );
  const visible = onlyReview ? reviewRows : rows;
  const lastPage = Math.max(0, Math.ceil(visible.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * pageSize;
  const canEditMatches = !!crosswalk.data && !crosswalk.isError && !saving;

  function chooseSku(line: number, sku?: string) {
    setChosenSkus((current) => {
      const next = new Map(current);
      if (sku) next.set(line, sku);
      else next.delete(line);
      return next;
    });
    setPickerLine(null);
    setApprovalError("");
  }

  const clearPreview = () => {
    inputVersion.current++;
    setCsv(null);
    setFileError("");
    setApprovalError("");
    setApproved(null);
    setApprovedLines(new Set());
    setPage(0);
    setOnlyReview(false);
    setChosenSkus(new Map());
    setPickerLine(null);
    return inputVersion.current;
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    const version = clearPreview();
    setDraftCsv("");
    if (!file) return;
    if (file.size > maxFileSize) {
      setFileError("Choose a CSV file of 2 MB or less.");
      return;
    }
    setReading(true);
    try {
      const data = await file.text();
      if (inputVersion.current !== version) return;
      setDraftCsv(data);
      setCsv(data);
    } catch {
      setFileError("The file could not be read. Choose the CSV again.");
    } finally {
      setReading(false);
    }
  };

  const previewPasted = () => {
    clearPreview();
    if (!draftCsv.trim()) return;
    if (new TextEncoder().encode(draftCsv).length > maxFileSize) {
      setFileError("Use CSV text of 2 MB or less.");
      return;
    }
    setCsv(draftCsv);
  };

  const approve = async () => {
    if (
      saving ||
      !canApprove ||
      !crosswalk.data ||
      crosswalk.isError ||
      !effectiveOn ||
      !source.trim()
    )
      return;
    const payload = {
      effectiveOn,
      source: source.trim(),
      rows: approvable.map((row) => ({
        supplier: row.supplier,
        supplierSku: row.supplierSku,
        manufacturerPartNumber: row.manufacturerPartNumber || undefined,
        productId: row.product!.id,
        productSku: row.product!.sku,
        unit: row.unit,
        unitCost: row.unitCost,
        ...(row.unit.trim().toLowerCase() ===
        row.product!.unit.trim().toLowerCase()
          ? {}
          : {
              stockUnit: row.product!.unit,
              stockUnitsPerBuyUnit: row.stockUnitsPerBuyUnit,
            }),
      })),
    };
    if (!payload.rows.length) return;
    if (
      payload.rows.length > maxApprovalRows ||
      new TextEncoder().encode(JSON.stringify(payload)).length >=
        maxApprovalBytes
    ) {
      setApprovalError(
        "Split this CSV into smaller files, with up to 2,500 approved rows in each file.",
      );
      return;
    }
    setSaving(true);
    setApprovalError("");
    try {
      const result = await operation<ApprovalResult>(
        `${crosswalkPath}/approve`,
        "POST",
        payload,
      );
      setApproved((current) => ({
        aliasesAdded: (current?.aliasesAdded ?? 0) + result.aliasesAdded,
        pricesAdded: (current?.pricesAdded ?? 0) + result.pricesAdded,
        alreadyApproved:
          (current?.alreadyApproved ?? 0) + result.alreadyApproved,
      }));
      setApprovedLines(
        (current) =>
          new Set([...current, ...approvable.map((row) => row.line)]),
      );
      void crosswalk.refetch();
    } catch (error) {
      setApprovalError(
        error instanceof Error
          ? error.message
          : "Approval could not be saved. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
      <DialogHeader className="pr-8">
        <DialogTitle>Preview supplier CSV</DialogTitle>
        <DialogDescription>
          Review supplier SKUs and negotiated buy costs before approval. If
          supplier and stock units differ, enter stock units per supplier unit
          in the CSV.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 grow basis-full space-y-1 text-sm font-medium sm:basis-0">
          <span>Supplier CSV</span>
          <Input
            type="file"
            accept=".csv,text/csv"
            onChange={readFile}
            disabled={reading || saving}
          />
        </label>
        <Button variant="outline" asChild>
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}
            download="supplier-import-template.csv"
          >
            Download template
          </a>
        </Button>
      </div>
      <div className="space-y-2">
        <label htmlFor="supplier-import-paste" className="text-sm font-medium">
          Paste supplier CSV
        </label>
        <Textarea
          id="supplier-import-paste"
          rows={5}
          className="font-mono text-xs"
          value={draftCsv}
          disabled={reading || saving}
          placeholder={template.trim()}
          aria-describedby="supplier-import-paste-help"
          onChange={(event) => {
            setDraftCsv(event.target.value);
            clearPreview();
          }}
        />
        <p
          id="supplier-import-paste-help"
          className="text-xs text-muted-foreground"
        >
          Include the CSV header and supplier rows shown in the template.
          Supplier SKUs and manufacturer part numbers keep their leading zeros.
          Preview the text, then choose an effective date and price source
          before explicit owner approval.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={reading || saving || !draftCsv.trim()}
          onClick={previewPasted}
        >
          Preview pasted supplier CSV
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Enter buy costs in USD per listed unit. Choose a catalog product in the
        preview for an unmatched supplier SKU.
      </p>
      {crosswalk.isError && (
        <p role="alert" className="text-sm text-destructive">
          Supplier crosswalk unavailable.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void crosswalk.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {reading && (
        <p role="status" className="text-sm">
          Reading supplier CSV…
        </p>
      )}
      {(fileError || !!preview?.errors.length) && (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {(fileError ? [fileError] : (preview?.errors ?? [])).map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {preview && rows.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p role="status">
              {rows.length.toLocaleString()} rows ·{" "}
              {reviewRows.length.toLocaleString()} to review
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={onlyReview}
                onChange={(event) => {
                  setOnlyReview(event.target.checked);
                  setPage(0);
                }}
              />
              Needs review only
            </label>
          </div>
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No rows need review.
            </p>
          ) : (
            <ol
              aria-label="Supplier CSV preview"
              className="divide-y rounded-lg border text-sm"
            >
              {visible.slice(start, start + pageSize).map((row) => {
                const saved = approvedLines.has(row.line);
                const editable = canEditMatches && !saved;
                return (
                  <li
                    key={row.line}
                    className="grid gap-2 break-words p-3 sm:grid-cols-2 lg:grid-cols-4"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">
                        {row.supplier || "Supplier missing"}
                      </p>
                      <p className="text-muted-foreground">
                        Line {row.line} ·{" "}
                        {row.supplierSku || "Supplier SKU missing"}
                      </p>
                      {row.manufacturerPartNumber && (
                        <p className="text-muted-foreground">
                          Mfr. part {row.manufacturerPartNumber}
                        </p>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p>
                        {row.product?.name || "No catalog product resolved"}
                      </p>
                      {row.product?.sku ? (
                        <p className="text-muted-foreground">
                          Catalog SKU {row.product.sku}
                        </p>
                      ) : (
                        (row.chosenSku || row.internalSku) && (
                          <p className="text-muted-foreground">
                            {row.chosenSku
                              ? `Selected SKU ${row.chosenSku}`
                              : `Requested SKU ${row.internalSku}`}
                          </p>
                        )
                      )}
                    </div>
                    <div className="min-w-0 tabular-nums">
                      {row.unitCost && (
                        <p>
                          CSV {row.unitCost} USD{row.unit && ` / ${row.unit}`}
                        </p>
                      )}
                      {row.product &&
                        row.stockUnitCost !== undefined &&
                        row.unit.trim().toLowerCase() !==
                          row.product.unit.trim().toLowerCase() && (
                          <p className="text-muted-foreground">
                            1 {row.unit} = {row.stockUnitsPerBuyUnit}{" "}
                            {row.product.unit} · {row.stockUnitCost} USD /{" "}
                            {row.product.unit}
                          </p>
                        )}
                      {row.latestPrice ? (
                        <p className="text-muted-foreground">
                          Latest approved {row.latestPrice.unitCost} USD /{" "}
                          {row.latestPrice.unit} · {row.latestPrice.effectiveOn}{" "}
                          · {row.latestPrice.source}
                        </p>
                      ) : (
                        row.product && (
                          <p className="text-muted-foreground">
                            Catalog {row.product.cost} USD / {row.product.unit}
                          </p>
                        )
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium">
                        {saved
                          ? "Approved"
                          : row.priceDifference === "higher"
                            ? "Higher buy cost"
                            : row.priceDifference === "lower"
                              ? "Lower buy cost"
                              : statusLabels[row.status]}
                      </p>
                      {row.status !== "matched" && (
                        <p className="text-muted-foreground">{row.message}</p>
                      )}
                      {row.status === "matched" && row.chosenSku && (
                        <p className="text-muted-foreground">{row.message}</p>
                      )}
                      {editable &&
                        row.canChooseProduct &&
                        pickerLine !== row.line && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-2"
                            onClick={() => setPickerLine(row.line)}
                          >
                            {row.chosenSku
                              ? "Change catalog product"
                              : "Choose catalog product"}
                          </Button>
                        )}
                      {editable && row.chosenSku && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="mt-2"
                          onClick={() => chooseSku(row.line)}
                        >
                          Clear selection
                        </Button>
                      )}
                    </div>
                    {editable &&
                      row.canChooseProduct &&
                      pickerLine === row.line && (
                        <CatalogSkuPicker
                          row={row}
                          products={selectableProducts}
                          onChoose={(sku) => chooseSku(row.line, sku)}
                          onCancel={() => setPickerLine(null)}
                        />
                      )}
                  </li>
                );
              })}
            </ol>
          )}
          {lastPage > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <p>
                Rows {start + 1}–{Math.min(start + pageSize, visible.length)} of{" "}
                {visible.length}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === lastPage}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          {canApprove && approvable.length > 0 && (
            <div className="space-y-3 rounded-md border p-3">
              <p className="text-sm">
                Approve {approvable.length.toLocaleString()} mapped{" "}
                {approvable.length === 1 ? "row" : "rows"}.{" "}
                {rows.length > approvable.length + approvedLines.size &&
                  `${(rows.length - approvable.length - approvedLines.size).toLocaleString()} unresolved rows need correction.`}
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-sm font-medium">
                  Effective date
                  <Input
                    type="date"
                    value={effectiveOn}
                    disabled={saving || !!approved}
                    onChange={(event) => setEffectiveOn(event.target.value)}
                  />
                </label>
                <label className="min-w-48 flex-1 space-y-1 text-sm font-medium">
                  Price source
                  <Input
                    value={source}
                    maxLength={200}
                    disabled={saving || !!approved}
                    onChange={(event) => setSource(event.target.value)}
                    placeholder="Vendor agreement or price list"
                  />
                </label>
                <Button
                  type="button"
                  onClick={() => void approve()}
                  disabled={
                    saving ||
                    !crosswalk.data ||
                    crosswalk.isError ||
                    !effectiveOn ||
                    !source.trim()
                  }
                >
                  {saving ? "Saving prices…" : "Approve matched rows"}
                </Button>
              </div>
              {approvalError && (
                <p role="alert" className="text-sm text-destructive">
                  {approvalError}
                </p>
              )}
            </div>
          )}
          {approved && (
            <p role="status" className="text-sm text-emerald-800">
              Saved {approved.aliasesAdded} mappings and {approved.pricesAdded}{" "}
              prices. {approved.alreadyApproved} rows were already approved.
            </p>
          )}
        </div>
      )}
    </DialogContent>
  );
}

export function SupplierImportDialog({
  products,
  disabled,
}: {
  products: readonly SupplierImportProduct[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={disabled}>
          Preview supplier CSV
        </Button>
      </DialogTrigger>
      {open && <SupplierImportContent products={products} />}
    </Dialog>
  );
}
