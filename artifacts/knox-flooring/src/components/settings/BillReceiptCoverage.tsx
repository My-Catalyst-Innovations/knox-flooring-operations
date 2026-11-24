import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operation } from "@/lib/operations";
import { inventorySelect } from "@/lib/purchasing";
import {
  receiptCoveragePath as path,
  coverageDecimal,
  coveragePriceDiffers,
  coverageRateDiffers,
  coverageRoundingProven,
  coveragePreviewRoundingProven,
  coverageRejected,
  coverageUsd,
  type CoverageApproval,
  type CoverageBillStatus,
  type CoverageChoice,
  type CoverageOptions,
  type CoveragePreview,
} from "@/lib/receipt-bill-coverage";
import { OriginalBillDocuments } from "./OriginalBillDocuments";

type Row = {
  id: string;
  receiptLineId: string;
  billKey: string;
  quantity: string;
  varianceNote: string;
  existingAllocationId: string;
  reconciliationNote: string;
};
const blank = (): Row => ({
  id: crypto.randomUUID(),
  receiptLineId: "",
  billKey: "",
  quantity: "",
  varianceNote: "",
  existingAllocationId: "",
  reconciliationNote: "",
});
const sameText = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export function BillReceiptCoverage({
  billId,
  onClose,
}: {
  billId: string;
  onClose(): void;
}) {
  const { user } = useAuth();
  if (
    !user ||
    user.role !== "owner" ||
    user.previewRole ||
    (user.actualRole && user.actualRole !== "owner")
  )
    return (
      <section aria-label="Receipt coverage">
        <p>
          Receipt coverage and original bill files require the actual owner
          account outside role preview.
        </p>
        <Button type="button" variant="outline" onClick={onClose}>
          Close receipt coverage
        </Button>
      </section>
    );
  return (
    <CoverageWorkspace
      key={`${user.id}:${billId}`}
      billId={billId}
      onClose={onClose}
    />
  );
}
function CoverageWorkspace({
  billId,
  onClose,
}: {
  billId: string;
  onClose(): void;
}) {
  const [saved, setSaved] = useState<CoverageBillStatus>();
  const [options, setOptions] = useState<CoverageOptions>();
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{
    result: CoveragePreview;
    choice: CoverageChoice;
  }>();
  const [confirmQuantities, setConfirmQuantities] = useState(false);
  const [confirmPrices, setConfirmPrices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState<{
    requestKey: string;
    choice: CoverageChoice;
    fingerprint: string;
  }>();
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [billId]);
  async function load() {
    setBusy(true);
    setError("");
    setOptions(undefined);
    try {
      const status = await operation<CoverageBillStatus>(
        `${path}/bills/${encodeURIComponent(billId)}`,
      );
      if (!alive.current) return;
      if (status.billId !== billId)
        throw new Error(
          "The supplier bill changed. Reopen its coverage review.",
        );
      setSaved(status);
      if (status.coverageAvailable) {
        const data = await operation<CoverageOptions>(
          `${path}/options?billId=${encodeURIComponent(billId)}`,
        );
        if (!alive.current) return;
        const validScope =
          data.mode === "local_review"
            ? data.company === null
            : data.mode === "quickbooks_verified" &&
              data.company &&
              typeof data.company.realmId === "string" &&
              /^\d{1,30}$/.test(data.company.realmId) &&
              ["sandbox", "production"].includes(data.company.environment) &&
              Boolean(data.company.connectionId && data.company.companyName);
        if (!validScope || data.mode !== status.mode)
          throw new Error(
            "The accounting scope could not be verified. Refresh this bill before reviewing coverage.",
          );
        setOptions(data);
      }
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not load saved receipt coverage.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function edit(action: () => void) {
    if (attempt || busy) return;
    action();
    setPreview(undefined);
    setConfirmQuantities(false);
    setConfirmPrices(false);
    setError("");
    setNotice("");
  }
  function update(id: string, values: Partial<Row>) {
    edit(() =>
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...values } : row)),
      ),
    );
  }
  const selected = rows.map((row) => ({
    row,
    bill: options?.bills.find((bill) => bill.key === row.billKey),
    receipt: options?.receipts.find(
      (receipt) => receipt.id === row.receiptLineId,
    ),
    base: options?.allocations.find(
      (item) => item.id === row.existingAllocationId,
    ),
  }));
  const tuples = selected.map(({ row, bill }) =>
    JSON.stringify([
      row.receiptLineId,
      bill?.billId,
      bill?.billLineIndex,
      row.existingAllocationId || null,
    ]),
  );
  const billIds = [
    ...new Set(
      selected
        .map(({ bill }) => bill?.billId)
        .filter((id): id is string => Boolean(id)),
    ),
  ].sort();
  const budgets = new Map<string, { quantity: bigint; available: bigint }>();
  for (const { row, bill, receipt, base } of selected) {
    const quantity = coverageDecimal(row.quantity);
    if (quantity === null || quantity <= 0n || !bill || !receipt) continue;
    const limits = [
      [`bill:${bill.key}`, bill.remainingQuantity],
      row.existingAllocationId
        ? [`base:${row.existingAllocationId}`, base?.unboundQuantity]
        : [`receipt:${receipt.id}`, receipt.remainingQuantity],
    ];
    for (const [key, text] of limits) {
      const available = text === undefined ? null : coverageDecimal(text);
      if (key && available !== null)
        budgets.set(key, {
          quantity: (budgets.get(key)?.quantity ?? 0n) + quantity,
          available,
        });
    }
  }
  const exceedsBudget = [...budgets.values()].some(
    (item) => item.quantity > item.available,
  );
  const canPreview = Boolean(
    options &&
    !exceedsBudget &&
    note.trim().length >= 10 &&
    note.trim().length <= 1000 &&
    rows.length &&
    rows.length <= 100 &&
    billIds.length <= 20 &&
    new Set(tuples).size === tuples.length &&
    selected.every(({ row, bill, receipt, base }) => {
      const endorsement = Boolean(row.existingAllocationId);
      const quantity = coverageDecimal(row.quantity),
        available = endorsement
          ? base
            ? coverageDecimal(base.unboundQuantity)
            : null
          : receipt
            ? coverageDecimal(receipt.remainingQuantity)
            : null,
        billAvailable = bill ? coverageDecimal(bill.remainingQuantity) : null;
      return (
        bill?.eligible &&
        receipt &&
        bill.productId === receipt.productId &&
        bill.stockUnit === receipt.stockUnit &&
        sameText(bill.supplier, receipt.supplier) &&
        bill.verification ===
          (options.mode === "local_review" ? "local_only" : "verified") &&
        quantity !== null &&
        quantity > 0n &&
        available !== null &&
        quantity <= available &&
        billAvailable !== null &&
        quantity <= billAvailable &&
        row.varianceNote.trim().length <= 500 &&
        (!coveragePriceDiffers(receipt, bill) ||
          row.varianceNote.trim().length >= 10) &&
        (!endorsement ||
          (options.mode === "quickbooks_verified" &&
            base?.mode === "local_review" &&
            base.receiptLineId === receipt.id &&
            base.productId === receipt.productId &&
            base.stockUnit === receipt.stockUnit &&
            sameText(base.sourceBillNumber, bill.billNumber) &&
            row.reconciliationNote.trim().length <= 500 &&
            (!coverageRateDiffers(base.billedUnitCost, bill.unitCost) ||
              row.reconciliationNote.trim().length >= 10)))
      );
    }),
  );
  async function prepare() {
    if (!canPreview || busy || pending.current || !options) return;
    const choice: CoverageChoice = {
      billIds,
      allocations: selected.map(({ row, bill }) => ({
        receiptLineId: row.receiptLineId,
        billId: bill!.billId,
        billLineIndex: bill!.billLineIndex,
        quantity: row.quantity,
        varianceNote: row.varianceNote.trim(),
        ...(row.existingAllocationId
          ? {
              existingAllocationId: row.existingAllocationId,
              reconciliationNote: row.reconciliationNote.trim(),
            }
          : {}),
      })),
      note: note.trim(),
    };
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPreview(undefined);
    setConfirmQuantities(false);
    setConfirmPrices(false);
    try {
      const result = await operation<CoveragePreview>(
        `${path}/preview`,
        "POST",
        choice,
      );
      if (!alive.current) return;
      if (
        result.mode !== options.mode ||
        result.company?.connectionId !== options.company?.connectionId ||
        result.company?.realmId !== options.company?.realmId ||
        result.company?.environment !== options.company?.environment
      )
        throw new Error(
          "The accounting scope changed. Refresh and review the intended bills again.",
        );
      if (
        result.lines.some(
          (line) =>
            line.varianceClassification === "unit_conversion_rounding" &&
            !coveragePreviewRoundingProven(line),
        )
      )
        throw new Error(
          "The conversion rounding evidence could not be verified. Refresh and review the original prices again.",
        );
      setPreview({ result, choice });
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Receipt coverage preview failed.",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function approve() {
    if (
      !preview ||
      !confirmQuantities ||
      !confirmPrices ||
      busy ||
      pending.current
    )
      return;
    const current = attempt ?? {
      requestKey: crypto.randomUUID(),
      choice: preview.choice,
      fingerprint: preview.result.fingerprint,
    };
    setAttempt(current);
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await operation<CoverageApproval>(
        `${path}/approve`,
        "POST",
        {
          ...current,
          confirmQuantities: true,
          confirmPriceVariances: true,
          confirmSourceIdentities: true,
        },
      );
      if (!alive.current) return;
      setAttempt(undefined);
      setPreview(undefined);
      setConfirmQuantities(false);
      setConfirmPrices(false);
      setRows([blank()]);
      setNote("");
      setNotice(
        `Local receipt coverage ${result.replayed ? "confirmed from the existing approval" : "saved"}. Stock, bill balances and provider transactions were not changed.`,
      );
      await load();
    } catch (failure) {
      if (!alive.current) return;
      // A rejected retry cannot disprove an earlier commit whose response was lost.
      if (coverageRejected(failure) && !attempt) {
        setAttempt(undefined);
        setPreview(undefined);
        setConfirmQuantities(false);
        setConfirmPrices(false);
        setError(
          `Coverage approval was rejected. Refresh and review again. ${failure.message}`,
        );
      } else
        setError(
          "The approval outcome is unknown. Retry the same approval to check its saved result; the reviewed choices and request reference are retained. A rejected retry does not establish whether the original request was saved.",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Receipt coverage"
      className="mt-3 space-y-4 rounded border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Supplier bill receipt coverage</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onClose}
        >
          Close receipt coverage
        </Button>
      </div>
      <p className="text-sm">
        Match accepted purchase receipt quantities to specific saved bill lines.
        A match records local evidence; it does not receive stock, revalue
        receipts, create a supplier credit, pay a bill, or post to QuickBooks.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || Boolean(attempt)}
        onClick={() => {
          setPreview(undefined);
          setConfirmQuantities(false);
          setConfirmPrices(false);
          void load();
        }}
      >
        Refresh saved coverage
      </Button>
      {busy && (
        <p role="status" className="text-sm">
          Loading or saving receipt coverage…
        </p>
      )}
      {saved && !saved.coverageAvailable && (
        <p className="text-sm">
          {saved.blockedReason ||
            "This bill is not eligible for receipt coverage yet."}
        </p>
      )}
      {options && (
        <>
          <p className="text-sm font-medium">
            {options.mode === "local_review"
              ? "Local owner review only · QuickBooks verification is pending."
              : `${options.company?.companyName} · ${options.company?.environment} · QuickBooks-verified bill evidence`}
          </p>
          <p className="text-xs text-muted-foreground">
            Accepted receipt quantities are gross purchases. Job returns remain
            company stock and do not reduce the purchase quantity covered by a
            bill.
          </p>
          {options.hasMore && (
            <p className="text-sm">
              This list is bounded. Reopen the intended bill to review
              additional eligible bills.
            </p>
          )}
          <fieldset disabled={busy || Boolean(attempt)} className="space-y-3">
            {rows.map((row, index) => {
              const bill = selected[index].bill;
              const receipt = selected[index].receipt;
              const base = selected[index].base;
              return (
                <div key={row.id} className="space-y-2 rounded border p-3">
                  <label className="block text-sm">
                    Bill line {index + 1}
                    <select
                      className={inventorySelect}
                      value={row.billKey}
                      onChange={(event) =>
                        update(row.id, {
                          billKey: event.target.value,
                          receiptLineId: "",
                          existingAllocationId: "",
                          reconciliationNote: "",
                        })
                      }
                    >
                      <option value="">Choose a saved bill line</option>
                      {options.bills.map((line) => (
                        <option
                          key={line.key}
                          value={line.key}
                          disabled={!line.eligible}
                        >
                          {line.billNumber} · {line.supplier} · {line.sku} ·{" "}
                          {line.productName} · Remaining{" "}
                          {line.remainingQuantity} {line.stockUnit}
                          {!line.eligible
                            ? ` · ${line.blockedReason || "Unavailable"}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    Receipt line {index + 1}
                    <select
                      className={inventorySelect}
                      value={row.receiptLineId}
                      onChange={(event) =>
                        update(row.id, {
                          receiptLineId: event.target.value,
                          existingAllocationId: "",
                          reconciliationNote: "",
                        })
                      }
                    >
                      <option value="">Choose an accepted receipt</option>
                      {options.receipts
                        .filter(
                          (line) =>
                            !bill ||
                            (line.productId === bill.productId &&
                              line.stockUnit === bill.stockUnit &&
                              sameText(line.supplier, bill.supplier)),
                        )
                        .map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.orderNumber} ·{" "}
                            {line.reference || line.receiptId} ·{" "}
                            {line.warehouseName} · {line.sku} · Remaining{" "}
                            {line.remainingQuantity} {line.stockUnit} · Cost{" "}
                            {coverageUsd(line.unitCost)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {options.mode === "quickbooks_verified" &&
                    bill &&
                    receipt && (
                      <>
                        <label className="block text-sm">
                          Prior local coverage {index + 1}
                          <select
                            className={inventorySelect}
                            value={row.existingAllocationId}
                            onChange={(event) =>
                              update(row.id, {
                                existingAllocationId: event.target.value,
                                reconciliationNote: "",
                              })
                            }
                          >
                            <option value="">
                              Record new receipt coverage
                            </option>
                            {options.allocations
                              .filter(
                                (item) =>
                                  item.mode === "local_review" &&
                                  item.receiptLineId === receipt.id &&
                                  sameText(
                                    item.sourceBillNumber,
                                    bill.billNumber,
                                  ) &&
                                  (coverageDecimal(item.unboundQuantity) ??
                                    0n) > 0n,
                              )
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  Reconcile prior local coverage · Bill{" "}
                                  {item.sourceBillNumber} · Unbound{" "}
                                  {item.unboundQuantity} {item.stockUnit} ·
                                  Original billed cost{" "}
                                  {coverageUsd(item.billedUnitCost)}
                                </option>
                              ))}
                          </select>
                        </label>
                        {base && (
                          <>
                            <p className="text-sm">
                              This adds provider evidence to existing local
                              coverage. Receipt coverage is not counted a second
                              time. The original billed cost{" "}
                              {coverageUsd(base.billedUnitCost)} remains
                              recorded.
                            </p>
                            <label className="block text-sm">
                              Prior coverage reconciliation reason {index + 1}
                              <Input
                                maxLength={500}
                                value={row.reconciliationNote}
                                onChange={(event) =>
                                  update(row.id, {
                                    reconciliationNote: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </>
                        )}
                      </>
                    )}
                  <label className="block text-sm">
                    Coverage quantity {index + 1}
                    <Input
                      inputMode="decimal"
                      value={row.quantity}
                      onChange={(event) =>
                        update(row.id, { quantity: event.target.value })
                      }
                    />
                  </label>
                  {bill && receipt && (
                    <p className="text-sm">
                      Receipt cost {coverageUsd(receipt.unitCost)} /{" "}
                      {receipt.stockUnit} · Billed cost{" "}
                      {coverageUsd(bill.unitCost)} / {bill.stockUnit}
                      {coveragePriceDiffers(receipt, bill)
                        ? " · Exact source rates differ; inspect source precision and explain the difference."
                        : coverageRoundingProven(receipt, bill)
                          ? " · Documented purchase-unit conversion rounding; the printed bill line cents agree."
                          : ""}
                    </p>
                  )}
                  <label className="block text-sm">
                    Price variance reason {index + 1}
                    <Input
                      maxLength={500}
                      value={row.varianceNote}
                      onChange={(event) =>
                        update(row.id, { varianceNote: event.target.value })
                      }
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={rows.length === 1}
                    onClick={() =>
                      edit(() =>
                        setRows((current) =>
                          current.filter((item) => item.id !== row.id),
                        ),
                      )
                    }
                  >
                    Remove coverage line {index + 1}
                  </Button>
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              disabled={rows.length >= 100}
              onClick={() =>
                edit(() => setRows((current) => [...current, blank()]))
              }
            >
              Add coverage line
            </Button>
            <label className="block text-sm">
              Owner coverage review note
              <Input
                maxLength={1000}
                value={note}
                onChange={(event) => edit(() => setNote(event.target.value))}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Use at least 10 characters to explain the source match. Quantities
              accept up to six decimal places.
            </p>
            {exceedsBudget && (
              <p className="text-sm text-destructive">
                Combined selections exceed an unallocated receipt quantity, bill
                quantity, or prior local coverage quantity. Reduce the selected
                quantities.
              </p>
            )}
            <Button
              type="button"
              disabled={!canPreview}
              onClick={() => void prepare()}
            >
              Preview receipt coverage
            </Button>
          </fieldset>
        </>
      )}
      {preview && (
        <div
          aria-label="Reviewed receipt coverage"
          className="space-y-3 rounded border p-3"
        >
          <h4 className="font-medium">
            Review exact quantities and acquisition prices
          </h4>
          <ul className="space-y-2">
            {preview.result.lines.map((line, index) => (
              <li key={index} className="text-sm">
                {line.receipt.orderNumber} ·{" "}
                {line.receipt.reference || line.receipt.receiptId} → Bill{" "}
                {line.bill.billNumber} · {line.bill.sku}
                <p>
                  {line.quantity} {line.receipt.stockUnit} · Receipt total{" "}
                  {coverageUsd(line.receiptExtendedCost)} · Bill total{" "}
                  {coverageUsd(line.billedExtendedCost)} · Difference{" "}
                  {coverageUsd(line.variance)}
                </p>
                <details>
                  <summary className="cursor-pointer">
                    Exact source quantities and costs
                  </summary>
                  <p>
                    Receipt rate {line.receipt.unitCost} /{" "}
                    {line.receipt.stockUnit} · Billed rate {line.bill.unitCost}{" "}
                    / {line.bill.stockUnit}
                  </p>
                  <p>
                    Receipt extended cost {line.receiptExtendedCost} USD ·
                    Billed extended cost {line.billedExtendedCost} USD · Exact
                    difference {line.variance} USD
                  </p>
                  {coveragePreviewRoundingProven(line) &&
                    line.roundingEvidence && (
                      <p>
                        Original purchase {line.roundingEvidence.buyQuantity}{" "}
                        units at{" "}
                        {coverageUsd(line.roundingEvidence.buyUnitCost)} per
                        purchase unit · Conversion{" "}
                        {line.roundingEvidence.stockUnitsPerBuyUnit}{" "}
                        {line.receipt.stockUnit} per purchase unit. The approved
                        purchase price, conversion and printed line cents agree;
                        original receipt cost is retained.
                      </p>
                    )}
                </details>
                {coveragePreviewRoundingProven(line) && (
                  <p>
                    Documented conversion rounding; no additional price variance
                    explanation is required.
                  </p>
                )}
                {line.varianceNote && (
                  <p>Owner variance reason: {line.varianceNote}</p>
                )}
                {line.existingAllocationId && (
                  <p>
                    Reconciles existing local coverage{" "}
                    {line.existingAllocationId}; no second receipt allocation.{" "}
                    {line.reconciliationNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Displayed totals are rounded to the nearest cent; a half cent rounds
            away from zero. Exact evidence is retained above. A rounded
            difference does not establish a price variance or revalue a receipt.
          </p>
          <p className="text-sm">Review note: {preview.choice.note}</p>
          {preview.result.hasHistoricalIdentities && (
            <p className="text-sm font-medium">
              This review includes legacy source identities. Verify the selected
              supplier, product and stock unit against the original bill; the
              original bill history is retained.
            </p>
          )}
          <ul className="text-sm">
            {preview.result.identityWarnings?.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          <ul className="text-sm">
            {preview.result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          <p className="text-sm font-medium">Unallocated after this review</p>
          <ul className="text-sm">
            {preview.result.receiptResiduals.map((item) => (
              <li key={item.id}>
                Receipt{" "}
                {options?.receipts.find((line) => line.id === item.id)
                  ?.reference || item.id}
                : {item.remainingQuantity}
              </li>
            ))}
            {preview.result.billResiduals.map((item) => (
              <li key={item.key}>
                Bill{" "}
                {options?.bills.find((line) => line.key === item.key)
                  ?.billNumber || item.key}
                : {item.remainingQuantity}
              </li>
            ))}
          </ul>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmQuantities}
              disabled={busy || Boolean(attempt)}
              onChange={(event) => setConfirmQuantities(event.target.checked)}
            />
            I confirm the supplier, product and source identities, exact stock
            units, and these receipt and bill quantities.
          </label>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmPrices}
              disabled={busy || Boolean(attempt)}
              onChange={(event) => setConfirmPrices(event.target.checked)}
            />
            I reviewed the acquisition prices and any explained price variances.
          </label>
          <Button
            type="button"
            disabled={busy || !confirmQuantities || !confirmPrices}
            onClick={() => void approve()}
          >
            {attempt
              ? "Retry same coverage approval"
              : "Save reviewed receipt coverage"}
          </Button>
        </div>
      )}
      {saved && (
        <>
          <h4 className="font-medium">Saved allocations for this bill</h4>
          {saved.allocations.length ? (
            <ul className="space-y-1 text-sm">
              {saved.allocations.map((item) => (
                <li key={item.id}>
                  {item.quantity} {item.stockUnit} · Receipt{" "}
                  {item.receiptLineId} · Receipt cost{" "}
                  {coverageUsd(item.receiptUnitCost)} · Original billed cost{" "}
                  {coverageUsd(item.billedUnitCost)} ·{" "}
                  {item.mode === "local_review"
                    ? "Local review"
                    : "Provider-verified"}{" "}
                  · Provider-bound across saved companies{" "}
                  {item.providerBoundQuantity} · Unbound {item.unboundQuantity}
                  {item.varianceNote && ` · ${item.varianceNote}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">No saved receipt coverage for this bill.</p>
          )}
          <OriginalBillDocuments
            key={billId}
            billId={billId}
            documents={saved.documents}
            onSaved={load}
          />
        </>
      )}
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
