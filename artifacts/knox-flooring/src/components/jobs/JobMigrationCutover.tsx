import { useRef, useState } from "react";
import {
  activeJobSourceStages,
  type JobCutoverPayload,
  type JobCutoverReview,
  type JobCutoverKind,
} from "@workspace/domain";
import type { Job } from "@/lib/types";
import { useAuth } from "@/contexts/auth";
import {
  operation,
  useOperation,
  useRefreshOperations,
} from "@/lib/operations";
import { dollarsToCents, type JobCutoverState } from "@/lib/active-job-import";
import { fmtMoney, jobForecast } from "@/lib/costing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const names = {
  operational: "Operational readiness",
  financial_context: "Full-job forecast",
  billing: "Remaining billing permission",
};
function FrozenCutoverPayload({
  payload,
  documents,
}: {
  payload: JobCutoverPayload;
  documents: JobCutoverState["evidenceDocuments"];
}) {
  return (
    <div className="space-y-2 text-sm">
      {payload.kind === "operational" ? (
        <p>
          Verified Works stage: {payload.targetStage}. No stock or calendar
          records are created.
        </p>
      ) : (
        <>
          {payload.kind === "financial_context" ? (
            <dl>
              {[
                ["Full-job forecast revenue", payload.fullJobRevenueCents],
                ["Full-job forecast labor", payload.fullJobLaborForecastCents],
                [
                  "Full-job forecast materials",
                  payload.fullJobMaterialForecastCents,
                ],
                [
                  "Full-job forecast other costs",
                  payload.fullJobOtherForecastCents,
                ],
              ].map(([name, cents]) => (
                <div
                  key={name as string}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <dt>{name}</dt>
                  <dd>{fmtMoney((cents as number) / 100)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>
              Gross Works invoice ceiling after all legacy invoices:{" "}
              {fmtMoney(payload.worksGrossInvoiceCeilingAfterLegacyCents / 100)}
              . No legacy balances or payments are created.
            </p>
          )}
          <p>
            Retained evidence:{" "}
            {payload.evidenceDocumentIds
              .map(
                (id) =>
                  documents.find((document) => document.id === id)?.name ??
                  `Document ${id}`,
              )
              .join("; ")}
          </p>
        </>
      )}
      <p className="whitespace-pre-wrap">Review basis: {payload.note}</p>
    </div>
  );
}
export function JobMigrationCutover({ job }: { job: Job }) {
  const { user } = useAuth();
  if (!job.migrationCutover || !user || user.role === "installer" || user.previewRole === "installer") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Imported job · cutover review</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          Source {job.migrationCutover.source.sourceSystem} · source ID{" "}
          {job.migrationCutover.source.sourceId} · original job{" "}
          {job.migrationCutover.source.sourceJobNumber || "Not recorded"} ·
          original stage {job.migrationCutover.source.sourceStatus}. Current
          Works stage: {job.status}.
        </p>
        <p className="text-sm">
          Source dates and stages are retained as provenance; they do not prove
          a real booking, received stock, completion, payment or profit.
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt>Full-job forecast revenue</dt>
            <dd>{fmtMoney(jobForecast(job)?.revenue ?? null)}</dd>
          </div>
          <div>
            <dt>Full-job actual profit / commission</dt>
            <dd>Unreconciled · excluded</dd>
          </div>
          <div>
            <dt>Works-recorded labor</dt>
            <dd>
              {fmtMoney(job.trackedLaborCost)}
              {(job.unpricedLaborCount ?? 0) > 0 &&
                ` · ${job.unpricedLaborCount} unpriced entries`}
            </dd>
          </div>
          <div>
            <dt>Works-recorded materials / receipts</dt>
            <dd>
              {fmtMoney(job.trackedMaterialCost)} /{" "}
              {fmtMoney(job.trackedExpenseCost)}
            </dd>
          </div>
        </dl>
        <p className="text-sm">
          These are separately recorded Works costs, not the job’s full
          historical actual cost.
        </p>
        {user?.role === "owner" && !user.previewRole ? (
          <CutoverOwner job={job} />
        ) : (
          <p>
            The owner must review the retained source and current evidence
            before unverified actions can proceed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CutoverOwner({ job }: { job: Job }) {
  const path = `/jobs/${encodeURIComponent(job.id)}/cutover`;
  const query = useOperation<JobCutoverState>(path, ["owner"]),
    refresh = useRefreshOperations();
  const [kind, setKind] = useState<JobCutoverKind>("operational"),
    [stage, setStage] = useState(""),
    [revenue, setRevenue] = useState(""),
    [labor, setLabor] = useState(""),
    [materials, setMaterials] = useState(""),
    [other, setOther] = useState(""),
    [ceiling, setCeiling] = useState(""),
    [documents, setDocuments] = useState<string[]>([]),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [selected, setSelected] = useState<JobCutoverReview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const active = useRef(false);
  const data = query.isError ? undefined : query.data;
  const cutover = data?.cutover;
  const invalidate = () => {
    setSelected(null);
    setConfirmed(false);
    setReviewConfirmed(false);
    setError("");
  };
  const run = async (fn: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The result could not be confirmed. Reload the saved reviews before retrying.",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const exact =
    !!selected &&
    !!data &&
    !!cutover &&
    selected.jobId === job.id &&
    selected.jobRevision === data.jobRevision &&
    selected.cutoverRevision === cutover.revision &&
    selected.scopeFingerprint === data.scopeFingerprint;
  if (query.isLoading)
    return <p role="status">Loading saved cutover reviews…</p>;
  if (!data || !cutover)
    return (
      <div role="alert">
        The current cutover state could not load.{" "}
        <Button onClick={() => void query.refetch()}>Retry cutover</Button>
      </div>
    );
  return (
    <section className="space-y-4 border-t pt-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <p>
          Operational review:{" "}
          {cutover.operational.current ? "Current" : "Pending or stale"}
        </p>
        <p>
          Full-job forecast:{" "}
          {cutover.financial.current
            ? "Current reviewed forecast"
            : "Unreconciled"}
        </p>
        <p>
          Billing permission:{" "}
          {cutover.billing.current
            ? "Current reviewed ceiling"
            : "Unreconciled"}
        </p>
      </div>
      <p>
        Remaining gross invoice ceiling:{" "}
        {fmtMoney(
          cutover.billing.current && cutover.billing.remainingCents !== null
            ? cutover.billing.remainingCents / 100
            : null,
        )}
        . Retained Works consumption:{" "}
        {fmtMoney(
          cutover.billing.consumedCents === null
            ? null
            : cutover.billing.consumedCents / 100,
        )}
        .
      </p>
      <p className="text-sm">
        The billing ceiling covers only scope not already invoiced in any legacy
        system, including unpaid legacy invoices. It is separate from full-job
        revenue. Drafts consume the ceiling; voids and refunds do not
        automatically restore it. A zero ceiling does not mean this job is paid.
      </p>
      <a
        href={`/api/active-job-imports/${encodeURIComponent(cutover.source.batchId)}/source`}
        className="text-primary underline"
      >
        Download original active-job source
      </a>
      {cutover.blockedActions.length > 0 && (
        <p>Blocked until review: {cutover.blockedActions.join(", ")}</p>
      )}
      {error && (
        <p role="alert" className="rounded border border-destructive p-3">
          {error}
        </p>
      )}
      <fieldset disabled={busy} className="space-y-3 rounded border p-3">
        <legend>Prepare a new evidence review</legend>
        <label className="block">
          Review type
          <select
            aria-label="Cutover review type"
            className="w-full rounded border p-2"
            value={kind}
            onChange={(event) => {
              invalidate();
              setKind(event.target.value as JobCutoverKind);
              setDocuments([]);
            }}
          >
            <option value="operational">Operational readiness</option>
            <option value="financial_context">Full-job forecast only</option>
            <option value="billing">Remaining gross billing ceiling</option>
          </select>
        </label>
        {kind === "operational" ? (
          <>
            <p>
              Complete actual material, crew-booking and closeout prerequisites
              using the job’s existing tools first. This review creates no
              calendar or stock records.
            </p>
            <label className="block">
              Verified current Works stage
              <select
                aria-label="Verified current Works stage"
                className="w-full rounded border p-2"
                value={stage}
                onChange={(event) => {
                  invalidate();
                  setStage(event.target.value);
                }}
              >
                <option value="">Choose the real current stage</option>
                {activeJobSourceStages
                  .filter((value) => !["Completed", "Invoiced"].includes(value))
                  .map((value) => (
                    <option key={value}>{value}</option>
                  ))}
              </select>
            </label>
          </>
        ) : (
          <>
            {kind === "financial_context" ? (
              <>
                <p>
                  Review the full job’s forecast, including legacy scope. These
                  values never establish actual costs, cash, profit or
                  commission eligibility.
                </p>
                {[
                  ["Full-job forecast revenue ($)", revenue, setRevenue],
                  ["Full-job forecast labor ($)", labor, setLabor],
                  ["Full-job forecast materials ($)", materials, setMaterials],
                  ["Full-job forecast other costs ($)", other, setOther],
                ].map(([label, value, setter]) => (
                  <label key={label as string} className="block">
                    {label as string}
                    <Input
                      aria-label={label as string}
                      inputMode="decimal"
                      value={value as string}
                      onChange={(event) => {
                        invalidate();
                        (setter as (value: string) => void)(event.target.value);
                      }}
                    />
                  </label>
                ))}
              </>
            ) : (
              <label className="block">
                Remaining gross Works invoice ceiling after all legacy invoices
                ($)
                <Input
                  aria-label="Remaining gross invoice ceiling"
                  inputMode="decimal"
                  value={ceiling}
                  onChange={(event) => {
                    invalidate();
                    setCeiling(event.target.value);
                  }}
                />
              </label>
            )}
            <p>
              Select 1–10 original evidence documents already uploaded in Job
              files. No external links or inferred evidence.
            </p>
            {data.hasMoreEvidenceDocuments && (
              <p>
                Only the first 100 documents are listed. Ask the office to
                identify the relevant retained documents before review.
              </p>
            )}
            {!data.evidenceDocuments.length && (
              <p>
                Upload supporting documents in Job files, then reload this
                review.
              </p>
            )}
            {data.evidenceDocuments.map((document) => (
              <label key={document.id} className="flex gap-2">
                <input
                  type="checkbox"
                  aria-label={`Evidence ${document.name}`}
                  checked={documents.includes(document.id)}
                  onChange={(event) => {
                    invalidate();
                    setDocuments((prior) =>
                      event.target.checked
                        ? [...prior, document.id]
                        : prior.filter((id) => id !== document.id),
                    );
                  }}
                />
                {document.name} · {document.size} bytes
              </label>
            ))}
          </>
        )}
        <label className="block">
          Review basis and limitations
          <Textarea
            aria-label="Cutover review note"
            value={note}
            onChange={(event) => {
              invalidate();
              setNote(event.target.value);
            }}
          />
        </label>
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {kind === "operational"
            ? "I verified actual operational readiness; imported stages do not supply that evidence."
            : kind === "financial_context"
              ? "These are full-job forecast figures only, not actuals or remaining billable scope."
              : "This ceiling accounts for all legacy invoices, including unpaid ones; it creates no legacy balances or payments."}
        </label>
        <Button
          disabled={
            !confirmed ||
            note.trim().length < 10 ||
            (kind === "operational"
              ? !stage
              : !documents.length || documents.length > 10)
          }
          onClick={() =>
            void run(async () => {
              let payload: JobCutoverPayload;
              if (kind === "operational")
                payload = {
                  kind,
                  targetStage: stage,
                  note,
                  confirmRealReadiness: true,
                };
              else if (kind === "financial_context")
                payload = {
                  kind,
                  fullJobRevenueCents: dollarsToCents(revenue),
                  fullJobLaborForecastCents: dollarsToCents(labor),
                  fullJobMaterialForecastCents: dollarsToCents(materials),
                  fullJobOtherForecastCents: dollarsToCents(other),
                  evidenceDocumentIds: documents,
                  note,
                  confirmForecastOnly: true,
                };
              else
                payload = {
                  kind,
                  worksGrossInvoiceCeilingAfterLegacyCents:
                    dollarsToCents(ceiling),
                  evidenceDocumentIds: documents,
                  note,
                  confirmIncludesAllLegacyInvoices: true,
                  confirmNoLegacyBalancesCreated: true,
                };
              setSelected(
                await operation(`${path}/reviews`, "POST", {
                  jobRevision: data.jobRevision,
                  cutoverRevision: cutover.revision,
                  payload,
                }),
              );
              setConfirmed(false);
              setReviewConfirmed(false);
              await query.refetch();
            })
          }
        >
          Save evidence review
        </Button>
      </fieldset>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await query.refetch();
            setSelected(null);
            setConfirmed(false);
          })
        }
      >
        Reload saved reviews
      </Button>
      <details>
        <summary>Saved cutover reviews</summary>
        {data.reviews.map((review) => (
          <div key={review.id} className="border-t py-2">
            <Button
              variant="link"
              disabled={busy}
              onClick={() => {
                setSelected(review);
                setReviewConfirmed(false);
              }}
            >
              {names[review.kind]} · {review.reviewedAt} ·{" "}
              {review.commit
                ? "Applied"
                : review.approval
                  ? "Approved"
                  : "Reviewed"}
            </Button>
          </div>
        ))}
      </details>
      {selected && (
        <section className="space-y-3 rounded border p-3">
          <h3 className="font-medium">Frozen review: {names[selected.kind]}</h3>
          <FrozenCutoverPayload
            payload={selected.payload}
            documents={data.evidenceDocuments}
          />
          <p className="break-all text-xs">
            Fingerprint: {selected.fingerprint}
          </p>
          {selected.commit ? (
            <p role="status">
              This review was applied. Refresh the job to see the current state;
              it remains subject to current evidence.
            </p>
          ) : (
            <>
              {!exact && (
                <p role="alert">
                  This review is stale. Prepare a new review of the current job
                  and evidence.
                </p>
              )}
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={reviewConfirmed}
                  disabled={!exact || busy}
                  onChange={(event) => setReviewConfirmed(event.target.checked)}
                />
                I reviewed this exact saved payload and its limitations.
              </label>
              {!selected.approval ? (
                <Button
                  disabled={!exact || !reviewConfirmed || busy}
                  onClick={() =>
                    void run(async () => {
                      setSelected(
                        await operation(
                          `${path}/reviews/${selected.id}/approve`,
                          "POST",
                          { fingerprint: selected.fingerprint },
                        ),
                      );
                      setConfirmed(false);
                      setReviewConfirmed(false);
                      await query.refetch();
                    })
                  }
                >
                  Approve frozen review
                </Button>
              ) : (
                <Button
                  disabled={!exact || !reviewConfirmed || busy}
                  onClick={() =>
                    void run(async () => {
                      setSelected(
                        await operation(
                          `${path}/reviews/${selected.id}/commit`,
                          "POST",
                          {
                            approvalId: selected.approval!.id,
                            fingerprint: selected.fingerprint,
                          },
                        ),
                      );
                      setReviewConfirmed(false);
                      await refresh();
                      await query.refetch();
                    })
                  }
                >
                  Apply approved cutover
                </Button>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
