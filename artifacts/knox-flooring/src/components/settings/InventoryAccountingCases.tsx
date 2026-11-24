import { useEffect, useRef, useState } from "react";
import type {
  InventoryAccountingCase,
  InventoryAccountingChoice,
  InventoryAccountingOptions,
  InventoryAccountingPreview,
  StockReturnPlan,
} from "@workspace/domain";
import { useAuth } from "@/contexts/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operation } from "@/lib/operations";
import { inventorySelect } from "@/lib/purchasing";
import { coverageRejected } from "@/lib/receipt-bill-coverage";

const path = "/quickbooks/inventory-accounting-cases";
const meaningful = (value: string) =>
  value.trim().length >= 10 && value.trim().length <= 1000;
const message = (failure: unknown) =>
  failure instanceof Error
    ? failure.message
    : "The inventory accounting review could not be completed.";
const sameChoice = (
  left: InventoryAccountingChoice,
  right: InventoryAccountingChoice,
) =>
  left.productId === right.productId &&
  left.jobId === right.jobId &&
  left.note === right.note &&
  JSON.stringify([...left.returnIds].sort()) ===
    JSON.stringify([...right.returnIds].sort());

function PlanEvidence({ plan }: { plan: StockReturnPlan }) {
  return plan.kind === "manual_review" ? (
    <div className="space-y-2 text-sm">
      <p className="font-medium">Accounting review required</p>
      <ul className="list-inside list-disc">
        {plan.explanations.map((text, index) => (
          <li key={index}>{text}</li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer">Review reason references</summary>
        <p>{plan.reasonCodes.join(", ")}</p>
      </details>
    </div>
  ) : (
    <div className="space-y-2 text-sm">
      <p className="font-medium">Quantity evidence ready for operator review</p>
      <p>
        Supported stock quantity difference: {plan.quantityDifference}. This
        review does not post to QuickBooks. An external adjustment requires
        separate document verification.
      </p>
      <ul>
        {plan.returnQuantities.map((item) => (
          <li key={item.returnId}>
            Return {item.returnId}: {item.quantity}
          </li>
        ))}
      </ul>
      {plan.warnings.map((text, index) => (
        <p key={index}>{text}</p>
      ))}
      <details>
        <summary className="cursor-pointer">Original source references</summary>
        {Object.entries(plan.sourceRefs).map(([kind, ids]) => (
          <p key={kind}>
            {kind}: {ids.join(", ")}
          </p>
        ))}
      </details>
    </div>
  );
}

export function InventoryAccountingCases({ productId }: { productId: string }) {
  const { user } = useAuth();
  if (
    !user ||
    user.role !== "owner" ||
    user.previewRole ||
    (user.actualRole && user.actualRole !== "owner")
  )
    return (
      <p>
        Inventory accounting cases require the actual owner outside role
        preview.
      </p>
    );
  return (
    <CaseWorkspace key={`${user.id}:${productId}`} productId={productId} />
  );
}

function CaseWorkspace({ productId }: { productId: string }) {
  const [options, setOptions] = useState<InventoryAccountingOptions>();
  const [jobId, setJobId] = useState("");
  const [returnIds, setReturnIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<InventoryAccountingPreview>();
  const [confirmReturns, setConfirmReturns] = useState(false);
  const [confirmNoPosting, setConfirmNoPosting] = useState(false);
  const [attempt, setAttempt] = useState<{
    requestKey: string;
    choice: InventoryAccountingChoice;
    fingerprint: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [productId]);
  async function load() {
    setBusy(true);
    setError("");
    setOptions(undefined);
    try {
      const result = await operation<InventoryAccountingOptions>(
        `${path}/options?productId=${encodeURIComponent(productId)}`,
      );
      if (!alive.current) return;
      if (
        result.product.id !== productId ||
        result.cases.some((item) => item.productId !== productId)
      )
        throw new Error("The product changed. Reopen its accounting review.");
      setOptions(result);
    } catch (failure) {
      if (alive.current) setError(message(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function edit(action: () => void) {
    if (busy || attempt) return;
    action();
    setPreview(undefined);
    setConfirmReturns(false);
    setConfirmNoPosting(false);
    setError("");
    setNotice("");
  }
  const available =
    options?.returns.filter((item) => item.jobId === jobId) ?? [];
  const canPreview = Boolean(
    options?.jobs.some((job) => job.id === jobId) &&
    meaningful(note) &&
    returnIds.length > 0 &&
    returnIds.length <= 100 &&
    returnIds.every((id) => available.some((item) => item.id === id)),
  );
  async function prepare() {
    if (!canPreview || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setPreview(undefined);
    setConfirmReturns(false);
    setConfirmNoPosting(false);
    const choice = {
      productId,
      jobId,
      returnIds: [...returnIds].sort(),
      note: note.trim(),
    };
    try {
      const result = await operation<InventoryAccountingPreview>(
        `${path}/preview`,
        "POST",
        choice,
      );
      if (!alive.current) return;
      const company = result.company;
      if (
        !sameChoice(result.choice, choice) ||
        !/^[a-f0-9]{64}$/.test(result.fingerprint) ||
        result.plan.providerSubmissionAllowed !== false ||
        result.plan.financialActionsAllowed !== false ||
        result.plan.revaluesInventory !== false ||
        (result.plan.kind === "ready_quantity_plan" &&
          (!company ||
            !company.connectionId ||
            !/^\d{1,30}$/.test(company.realmId) ||
            !["sandbox", "production"].includes(company.environment)))
      )
        throw new Error(
          "The returned accounting scope or evidence changed. Refresh before reviewing again.",
        );
      setPreview(result);
    } catch (failure) {
      if (alive.current) setError(message(failure));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (!preview || !confirmReturns || !confirmNoPosting || pending.current)
      return;
    const current = attempt ?? {
      requestKey: crypto.randomUUID(),
      choice: preview.choice,
      fingerprint: preview.fingerprint,
    };
    setAttempt(current);
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await operation<{
        case: InventoryAccountingCase;
        replayed: boolean;
      }>(path, "POST", { ...current, confirmNoFinancialPosting: true });
      if (!alive.current) return;
      if (result.case.productId !== productId)
        throw new Error("The saved case product could not be verified.");
      setAttempt(undefined);
      setPreview(undefined);
      setConfirmReturns(false);
      setConfirmNoPosting(false);
      setReturnIds([]);
      setNote("");
      setNotice(
        `Inventory accounting case ${result.replayed ? "confirmed from its existing record" : "saved"}. No stock or QuickBooks transaction was changed.`,
      );
      await load();
    } catch (failure) {
      if (!alive.current) return;
      // Keep the original identity after uncertainty, including access-error retries.
      if (coverageRejected(failure) && !attempt) {
        setAttempt(undefined);
        setPreview(undefined);
        setConfirmReturns(false);
        setConfirmNoPosting(false);
        setError(
          `Case approval was rejected. Refresh and review again. ${message(failure)}`,
        );
      } else
        setError(
          "The saved-case outcome is unknown. Retry the same approval; the reviewed choices and request reference are retained. A rejected retry does not establish whether the original case was saved.",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Inventory accounting cases"
      className="space-y-4 rounded border p-4"
    >
      <h3 className="font-semibold">Inventory accounting review</h3>
      <p className="text-sm">
        Review repeated returns and material sources together. Save
        missing-evidence cases for follow-up or retain a supported quantity plan
        for your accounting operator. Works does not submit a transaction from
        this review.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy || Boolean(attempt)}
        onClick={() => {
          setPreview(undefined);
          setConfirmReturns(false);
          setConfirmNoPosting(false);
          void load();
        }}
      >
        Refresh accounting cases
      </Button>
      {busy && <p role="status">Reading or saving accounting evidence…</p>}
      {options && (
        <>
          <p className="text-sm font-medium">
            {options.product.sku} · {options.product.name} ·{" "}
            {options.product.unit}
          </p>
          {options.hasMore && (
            <p className="text-sm">
              This list is bounded. Additional source records require a separate
              review.
            </p>
          )}
          <fieldset disabled={busy || Boolean(attempt)} className="space-y-3">
            <label className="block text-sm">
              Job for returned material
              <select
                className={inventorySelect}
                value={jobId}
                onChange={(event) =>
                  edit(() => {
                    setJobId(event.target.value);
                    setReturnIds([]);
                  })
                }
              >
                <option value="">Choose a job</option>
                {options.jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.number} · {job.customerName}
                  </option>
                ))}
              </select>
            </label>
            {jobId && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Recorded returns to review together
                </p>
                {available.length ? (
                  available.map((item) => (
                    <label key={item.id} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={returnIds.includes(item.id)}
                        onChange={(event) =>
                          edit(() =>
                            setReturnIds((current) =>
                              event.target.checked
                                ? [...current, item.id]
                                : current.filter((id) => id !== item.id),
                            ),
                          )
                        }
                      />
                      {item.quantity} {options.product.unit} · {item.reason} ·{" "}
                      {item.createdAt} · Return {item.id}
                    </label>
                  ))
                ) : (
                  <p className="text-sm">
                    No recorded returns for this job and product.
                  </p>
                )}
              </div>
            )}
            <label className="block text-sm">
              Accounting review note
              <Input
                maxLength={1000}
                value={note}
                onChange={(event) => edit(() => setNote(event.target.value))}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Use at least 10 characters to describe the sources and the
              accounting question.
            </p>
            <Button
              type="button"
              disabled={!canPreview}
              onClick={() => void prepare()}
            >
              Preview inventory accounting case
            </Button>
          </fieldset>
          {preview && (
            <div
              aria-label="Reviewed inventory accounting case"
              className="space-y-3 rounded border p-3"
            >
              <p className="text-sm font-medium">
                {preview.company
                  ? `${preview.company.companyName} · ${preview.company.environment}`
                  : "Local review · QuickBooks verification pending"}
              </p>
              <PlanEvidence plan={preview.plan} />
              <p className="text-sm">Review note: {preview.choice.note}</p>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmReturns}
                  disabled={busy || Boolean(attempt)}
                  onChange={(event) => setConfirmReturns(event.target.checked)}
                />
                I reviewed the selected returns, source evidence and unresolved
                accounting questions.
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmNoPosting}
                  disabled={busy || Boolean(attempt)}
                  onChange={(event) =>
                    setConfirmNoPosting(event.target.checked)
                  }
                />
                I understand saving this case does not post to QuickBooks,
                revalue inventory or create a credit or refund.
              </label>
              <Button
                type="button"
                disabled={busy || !confirmReturns || !confirmNoPosting}
                onClick={() => void save()}
              >
                {attempt
                  ? "Retry same case approval"
                  : "Save reviewed accounting case"}
              </Button>
            </div>
          )}
          <h4 className="font-medium">Saved accounting cases</h4>
          {options.cases.length ? (
            options.cases.map((item) => (
              <SavedCase key={item.id} item={item} onChanged={load} />
            ))
          ) : (
            <p className="text-sm">
              No saved accounting cases for this product.
            </p>
          )}
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

function SavedCase({
  item,
  onChanged,
}: {
  item: InventoryAccountingCase;
  onChanged(): Promise<void>;
}) {
  return (
    <article className="space-y-3 rounded border p-3 text-sm">
      <p className="font-medium">
        {item.reference} ·{" "}
        {item.kind === "manual_review"
          ? "Manual accounting review"
          : "Saved quantity plan"}
      </p>
      <p>
        {item.company
          ? `${item.company.companyName} · ${item.company.environment}`
          : "Local review; no connected accounting company"}
      </p>
      <p>{item.note}</p>
      <PlanEvidence plan={item.plan} />
      <p>Created {item.createdAt}</p>
      {item.events.map((event) => (
        <div key={event.id} className="space-y-1">
          <p>
            {event.kind === "external_adjustment_verified"
              ? `External adjustment document verified · QuickBooks ID ${event.adjustmentId}`
              : "Operator note"}{" "}
            · {event.note} · {event.createdAt}
          </p>
          {event.kind === "external_adjustment_verified" &&
            (event.balanceObservation ? (
              <>
                <p>
                  {event.balanceObservation.matchesCurrentWorks
                    ? "Observed quantities match"
                    : "Observed quantities differ; review current stock"}{" "}
                  · Works {event.balanceObservation.worksQuantity} · QuickBooks{" "}
                  {event.balanceObservation.quickBooksQuantity} · Observed{" "}
                  {event.balanceObservation.observedAt}
                </p>
                <p>
                  The observed QuickBooks quantity{" "}
                  {event.balanceObservation.matchesSavedTarget
                    ? "matched"
                    : "differed from"}{" "}
                  the saved case target at verification. Document verification
                  does not establish a current stock reconciliation.
                </p>
              </>
            ) : (
              <p>
                No stock balance observation was retained for this document.
              </p>
            ))}
        </div>
      ))}
      <CaseAction key={`note:${item.id}`} item={item} onChanged={onChanged} />
      {item.kind === "return_quantity_plan" &&
        item.company &&
        !item.events.some(
          (event) => event.kind === "external_adjustment_verified",
        ) && (
          <CaseAction
            key={`verify:${item.id}`}
            item={item}
            verify
            onChanged={onChanged}
          />
        )}
    </article>
  );
}

function CaseAction({
  item,
  verify = false,
  onChanged,
}: {
  item: InventoryAccountingCase;
  verify?: boolean;
  onChanged(): Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [adjustmentId, setAdjustmentId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{
    requestKey: string;
    note: string;
    adjustmentId?: string;
  } | null>(null);
  const pending = useRef(false);
  async function save() {
    if (
      pending.current ||
      !meaningful(note) ||
      (verify && (!confirmed || !/^\d{1,30}$/.test(adjustmentId)))
    )
      return;
    const current = attempt.current ?? {
      requestKey: crypto.randomUUID(),
      note: note.trim(),
      ...(verify ? { adjustmentId } : {}),
    };
    attempt.current = current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await operation<InventoryAccountingCase>(
        `${path}/${encodeURIComponent(item.id)}/${verify ? "verify-adjustment" : "notes"}`,
        "POST",
        current,
      );
      attempt.current = null;
      setUncertain(false);
      setNote("");
      setAdjustmentId("");
      setConfirmed(false);
      await onChanged();
    } catch (failure) {
      if (coverageRejected(failure) && !uncertain) {
        attempt.current = null;
        setUncertain(false);
        setError(message(failure));
      } else {
        setUncertain(true);
        setError(
          "The saved result is unknown. Retry the same request to recover its confirmation. A rejected retry does not establish whether the original update was saved.",
        );
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 border-t pt-3">
      <fieldset disabled={busy || uncertain} className="space-y-2">
        {verify && (
          <>
            <p>
              After your accounting operator creates an adjustment separately in
              QuickBooks, retain reference <strong>{item.reference}</strong> on
              that adjustment. Verify its existing ID here; Works only reads and
              verifies it.
            </p>
            <label className="block">
              Existing QuickBooks adjustment ID
              <Input
                inputMode="numeric"
                value={adjustmentId}
                onChange={(event) => setAdjustmentId(event.target.value.trim())}
              />
            </label>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I have reviewed the existing adjustment and its exact case
              reference.
            </label>
          </>
        )}
        <label className="block">
          {verify ? "Adjustment verification note" : "Operator follow-up note"}
          <Input
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </fieldset>
      <Button
        type="button"
        variant="outline"
        disabled={
          busy ||
          !meaningful(note) ||
          (verify && (!confirmed || !/^\d{1,30}$/.test(adjustmentId)))
        }
        onClick={() => void save()}
      >
        {uncertain
          ? "Retry same case update"
          : verify
            ? "Verify existing adjustment"
            : "Save operator note"}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
