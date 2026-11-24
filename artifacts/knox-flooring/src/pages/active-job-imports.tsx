import { useRef, useState } from "react";
import { Link } from "wouter";
import type {
  ActiveJobImportBatch,
  ActiveJobImportDecision,
} from "@workspace/domain";
import { useAuth } from "@/contexts/auth";
import {
  operation,
  useOperation,
  useRefreshOperations,
} from "@/lib/operations";
import {
  activeJobDecisionRequest,
  readActiveJobCsv,
  type ActiveJobChoices,
} from "@/lib/active-job-import";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const selectClass = "w-full rounded border bg-background p-2 text-sm";
type Summary = {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  status: string;
};
export default function ActiveJobImports() {
  const { user } = useAuth();
  if (user?.role !== "owner" || user.previewRole)
    return <p>Active-job import requires the owner outside role preview.</p>;
  return <ImportWorkspace />;
}
function ImportWorkspace() {
  const history = useOperation<Summary[]>("/active-job-imports", ["owner"]);
  const refresh = useRefreshOperations();
  const [search, setSearch] = useState("");
  const choices = useOperation<ActiveJobChoices>(
    `/active-job-imports/choices?q=${encodeURIComponent(search)}`,
    ["owner"],
  );
  const [sourceSystem, setSourceSystem] = useState(""),
    [batchKey, setBatchKey] = useState(""),
    [fileName, setFileName] = useState("Pasted active jobs.csv"),
    [csv, setCsv] = useState(""),
    [delimiter, setDelimiter] = useState<"," | "\t">(",");
  const [batch, setBatch] = useState<ActiveJobImportBatch | null>(null),
    [decisions, setDecisions] = useState<
      Record<number, Partial<ActiveJobImportDecision>>
    >({}),
    [note, setNote] = useState(""),
    [dirty, setDirty] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(false),
    fileRead = useRef(0);
  const saved = (value: ActiveJobImportBatch) => {
    setBatch(value);
    setDecisions(
      Object.fromEntries(
        value.decisions.map((choice) => [
          choice.line,
          activeJobDecisionRequest(choice),
        ]),
      ),
    );
    setNote(value.reviewNote ?? "");
    setDirty(false);
    setConfirmed(false);
  };
  const run = async (action: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The result could not be confirmed. Reload the saved batch before retrying.",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const patch = (line: number, choice: Partial<ActiveJobImportDecision>) => {
    setDecisions((all) => ({
      ...all,
      [line]: { ...all[line], ...choice, line },
    }));
    setDirty(true);
    setConfirmed(false);
  };
  const editable = batch?.status === "preview" || batch?.status === "reviewed";
  const ready =
    !!batch &&
    batch.rows.every((row) => {
      const choice = decisions[row.line];
      return (
        choice?.action &&
        (choice.note?.trim().length ?? 0) >= 5 &&
        (choice.action === "skip" ||
          (choice.customerId &&
            choice.siteId !== undefined &&
            (choice.action === "link"
              ? choice.jobId
              : choice.entryStage &&
                choice.flooringType &&
                typeof choice.acceptSourceDates === "boolean" &&
                (choice.entryStage === row.data.source_status ||
                  (choice.stageMappingReason?.trim().length ?? 0) >= 5))))
      );
    });
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="text-2xl font-semibold">Import active jobs</h1>
      <p className="rounded border bg-muted/30 p-4 text-sm">
        Create operational job records with unknown finances, or explicitly link
        an existing job without changing it. This import does not create
        bookings, received stock, invoices, balances, payments, accounting
        exports or messages. Closed work belongs in the{" "}
        <Link href="/legacy-history" className="text-primary underline">
          history archive
        </Link>
        .
      </p>
      {error && (
        <p role="alert" className="rounded border border-destructive p-3">
          {error}
        </p>
      )}
      <details>
        <summary>Saved import batches</summary>
        {history.isError ? (
          <p role="alert">
            Saved batches could not load.{" "}
            <Button onClick={() => void history.refetch()}>Retry</Button>
          </p>
        ) : history.isLoading ? (
          <p>Loading saved batches…</p>
        ) : (
          <ul>
            {history.data?.map((item) => (
              <li key={item.id}>
                <Button
                  variant="link"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      saved(
                        await operation(
                          `/active-job-imports/${encodeURIComponent(item.id)}`,
                        ),
                      ),
                    )
                  }
                >
                  {item.sourceSystem} · {item.batchKey} · {item.fileName} ·{" "}
                  {item.status}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </details>
      {!batch ? (
        <fieldset disabled={busy} className="space-y-3 rounded border p-4">
          <a
            href="/api/active-job-imports/template"
            className="text-primary underline"
          >
            Download the header-only CSV template
          </a>
          <p className="text-sm">
            Required headers: source_id, source_status. Up to 200 rows and 1
            MiB, UTF-8 CSV or TSV. IDs stay text, including leading zeros. Leave
            unknown dates blank. Financial columns are refused.
          </p>
          <label className="block">
            Source system
            <Input
              aria-label="Source system"
              value={sourceSystem}
              onChange={(event) => setSourceSystem(event.target.value)}
              placeholder="Use the actual source system name"
            />
          </label>
          <label className="block">
            Unique source batch key
            <Input
              aria-label="Source batch key"
              value={batchKey}
              onChange={(event) => setBatchKey(event.target.value)}
            />
          </label>
          <label className="block">
            Source filename
            <Input
              aria-label="Source filename"
              value={fileName}
              onChange={(event) => setFileName(event.target.value)}
            />
          </label>
          <label className="block">
            Choose source file
            <Input
              aria-label="Choose active-job source file"
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              onChange={(event) => {
                const file = event.target.files?.[0],
                  generation = ++fileRead.current;
                setCsv("");
                setFileName("Pasted active jobs.csv");
                setError("");
                if (!file) return;
                void readActiveJobCsv(file)
                  .then((value) => {
                    if (generation !== fileRead.current) return;
                    setCsv(value);
                    setFileName(file.name);
                    setDelimiter(
                      file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
                    );
                  })
                  .catch((cause) => {
                    if (generation === fileRead.current)
                      setError(cause.message);
                  });
              }}
            />
          </label>
          <label className="block">
            Paste source CSV or TSV
            <Textarea
              aria-label="Source CSV or TSV"
              rows={7}
              value={csv}
              onChange={(event) => {
                ++fileRead.current;
                setCsv(event.target.value);
              }}
            />
          </label>
          <label className="block">
            Delimiter
            <select
              className={selectClass}
              aria-label="Delimiter"
              value={delimiter}
              onChange={(event) =>
                setDelimiter(event.target.value as "," | "\t")
              }
            >
              <option value=",">Comma CSV</option>
              <option value={"\t"}>Tab TSV</option>
            </select>
          </label>
          <Button
            disabled={!csv || !sourceSystem || !batchKey || !fileName}
            onClick={() =>
              void run(async () => {
                saved(
                  await operation("/active-job-imports/preview", "POST", {
                    sourceSystem,
                    batchKey,
                    fileName,
                    csv,
                    delimiter,
                  }),
                );
                await history.refetch();
              })
            }
          >
            Save source preview
          </Button>
        </fieldset>
      ) : (
        <section className="space-y-4 rounded border p-4">
          <h2 className="font-semibold">
            {batch.sourceSystem} · {batch.fileName} · {batch.status}
          </h2>
          <p className="break-all text-xs">
            Original source SHA-256: {batch.sourceSha256}
          </p>
          <a
            className="text-primary underline"
            href={`/api/active-job-imports/${encodeURIComponent(batch.id)}/source`}
          >
            Download original source
          </a>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  saved(await operation(`/active-job-imports/${batch.id}`)),
                )
              }
            >
              Reload saved batch
            </Button>
            {editable && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    saved(
                      await operation(
                        `/active-job-imports/${batch.id}/refresh`,
                        "POST",
                        { revision: batch.revision },
                      ),
                    ),
                  )
                }
              >
                Refresh source identities
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBatch(null);
                setConfirmed(false);
              }}
            >
              Choose another source
            </Button>
          </div>
          {editable && (
            <label className="block">
              Search existing customers and jobs
              <Input
                aria-label="Search existing customers and jobs"
                value={search}
                maxLength={80}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          )}
          {choices.isError && editable && (
            <p role="alert">
              Existing choices could not load. Refresh before selecting.{" "}
              <Button onClick={() => void choices.refetch()}>
                Retry choices
              </Button>
            </p>
          )}
          {(choices.data?.hasMoreCustomers || choices.data?.hasMoreJobs) && (
            <p>
              Narrow your search to find the exact existing customer or job;
              these lists are bounded.
            </p>
          )}
          {batch.rows.map((row) => {
            const choice = decisions[row.line] ?? {},
              customer = choices.data?.customers.find(
                (item) => item.id === choice.customerId,
              ),
              invalid =
                row.errors.length > 0 ||
                row.fileDuplicates.length > 0 ||
                !!row.imported;
            return (
              <fieldset
                key={row.line}
                disabled={busy || !editable}
                className="space-y-3 rounded border p-3"
              >
                <legend>
                  Line {row.line} · Source ID {row.data.source_id}
                </legend>
                <p>
                  Source job: {row.data.source_job_number || "Not recorded"} ·
                  Original stage: {row.data.source_status}
                </p>
                <details>
                  <summary>Original source fields</summary>
                  <dl>
                    {Object.entries(row.data).map(([key, value]) => (
                      <div key={key}>
                        <dt className="inline font-medium">{key}: </dt>
                        <dd className="inline whitespace-pre-wrap">
                          {value || "Not recorded"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
                {[
                  ...row.errors,
                  ...row.warnings,
                  ...(row.fileDuplicates.length
                    ? ["Duplicate source identity in this file."]
                    : []),
                  ...(row.imported
                    ? ["This source identity is already bound."]
                    : []),
                ].map((warning, index) => (
                  <p key={index} className="text-sm">
                    {warning}
                  </p>
                ))}
                <label className="block">
                  Decision for line {row.line}
                  <select
                    className={selectClass}
                    aria-label={`Decision line ${row.line}`}
                    value={choice.action ?? ""}
                    onChange={(event) => {
                      setDecisions((all) => ({
                        ...all,
                        [row.line]: {
                          line: row.line,
                          action: event.target
                            .value as ActiveJobImportDecision["action"],
                          note: "",
                        },
                      }));
                      setDirty(true);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">Choose explicitly</option>
                    <option value="create" disabled={invalid}>
                      Create a new Works job
                    </option>
                    <option value="link" disabled={invalid}>
                      Link existing job; keep it unchanged
                    </option>
                    <option value="skip">Skip with reason</option>
                  </select>
                </label>
                {choice.action && choice.action !== "skip" && (
                  <>
                    <label className="block">
                      Existing customer
                      <select
                        className={selectClass}
                        aria-label={`Customer line ${row.line}`}
                        value={choice.customerId ?? ""}
                        onChange={(event) => {
                          const item = choices.data?.customers.find(
                            (candidate) => candidate.id === event.target.value,
                          );
                          patch(row.line, {
                            customerId: item?.id,
                            customerRevision: item?.revision,
                            siteId: undefined,
                            siteFingerprint: undefined,
                            jobId: undefined,
                            jobRevision: undefined,
                          });
                        }}
                      >
                        <option value="">Choose an existing customer</option>
                        {choice.customerId && !customer && (
                          <option value={choice.customerId}>
                            Previously selected customer · search to verify
                          </option>
                        )}
                        {choices.data?.customers.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {item.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      Existing site
                      <select
                        className={selectClass}
                        aria-label={`Site line ${row.line}`}
                        value={
                          choice.siteId === null
                            ? "none"
                            : (choice.siteId ?? "")
                        }
                        onChange={(event) => {
                          const site = customer?.sites.find(
                            (item) => item.id === event.target.value,
                          );
                          patch(row.line, {
                            siteId:
                              event.target.value === "none" ? null : site?.id,
                            siteFingerprint: site?.fingerprint ?? null,
                            jobId: undefined,
                            jobRevision: undefined,
                          });
                        }}
                      >
                        <option value="">
                          Choose site or explicitly no site
                        </option>
                        <option value="none">No site link</option>
                        {customer?.sites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.label} · {site.address} · {site.city}
                          </option>
                        ))}
                      </select>
                    </label>
                    {choice.action === "link" ? (
                      <label className="block">
                        Existing Works job
                        <select
                          className={selectClass}
                          aria-label={`Existing job line ${row.line}`}
                          value={choice.jobId ?? ""}
                          onChange={(event) => {
                            const job = choices.data?.jobs.find(
                              (item) => item.id === event.target.value,
                            );
                            patch(row.line, {
                              jobId: job?.id,
                              jobRevision: job?.revision,
                            });
                          }}
                        >
                          <option value="">
                            Choose the exact existing job
                          </option>
                          {choices.data?.jobs
                            .filter(
                              (job) =>
                                job.customerId === choice.customerId &&
                                job.siteId === choice.siteId,
                            )
                            .map((job) => (
                              <option key={job.id} value={job.id}>
                                {job.jobNumber} · {job.status}
                              </option>
                            ))}
                        </select>
                      </label>
                    ) : (
                      <>
                        <label className="block">
                          Works entry stage
                          <select
                            className={selectClass}
                            aria-label={`Works entry stage line ${row.line}`}
                            value={choice.entryStage ?? ""}
                            onChange={(event) =>
                              patch(row.line, {
                                entryStage: event.target.value,
                              })
                            }
                          >
                            <option value="">Choose a safe entry stage</option>
                            {choices.data?.entryStages.map((stage) => (
                              <option key={stage}>{stage}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          Reason for different entry stage
                          <Input
                            aria-label={`Stage mapping reason line ${row.line}`}
                            value={choice.stageMappingReason ?? ""}
                            onChange={(event) =>
                              patch(row.line, {
                                stageMappingReason: event.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="block">
                          Supported flooring type
                          <select
                            className={selectClass}
                            aria-label={`Flooring type line ${row.line}`}
                            value={choice.flooringType ?? ""}
                            onChange={(event) =>
                              patch(row.line, {
                                flooringType: event.target.value,
                              })
                            }
                          >
                            <option value="">Choose explicitly</option>
                            {choices.data?.flooringTypes.map((floor) => (
                              <option key={floor}>{floor}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          Source dates and approval date
                          <select
                            className={selectClass}
                            aria-label={`Source dates line ${row.line}`}
                            value={
                              choice.acceptSourceDates === undefined
                                ? ""
                                : String(choice.acceptSourceDates)
                            }
                            onChange={(event) =>
                              patch(row.line, {
                                acceptSourceDates:
                                  event.target.value === ""
                                    ? undefined
                                    : event.target.value === "true",
                              })
                            }
                          >
                            <option value="">Choose explicitly</option>
                            <option value="false">
                              Defer dates; keep them only in source provenance
                            </option>
                            <option value="true">
                              Retain exact source dates and approval date; no
                              booking is created
                            </option>
                          </select>
                        </label>
                      </>
                    )}
                  </>
                )}
                <label className="block">
                  Identity decision or skip reason
                  <Textarea
                    aria-label={`Decision note line ${row.line}`}
                    value={choice.note ?? ""}
                    onChange={(event) =>
                      patch(row.line, { note: event.target.value })
                    }
                  />
                </label>
              </fieldset>
            );
          })}
          <label className="block">
            Batch review note
            <Textarea
              disabled={busy || !editable}
              aria-label="Batch review note"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setDirty(true);
                setConfirmed(false);
              }}
            />
          </label>
          {editable && (
            <Button
              disabled={busy || !ready || note.trim().length < 5}
              onClick={() =>
                void run(async () =>
                  saved(
                    await operation(
                      `/active-job-imports/${batch.id}/review`,
                      "POST",
                      {
                        revision: batch.revision,
                        previewFingerprint: batch.previewFingerprint,
                        note,
                        decisions: batch.rows.map((row) =>
                          activeJobDecisionRequest(decisions[row.line]),
                        ),
                      },
                    ),
                  ),
                )
              }
            >
              Save exact review
            </Button>
          )}
          {(batch.status === "reviewed" || batch.status === "approved") && (
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || dirty}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I reviewed every mapping. New jobs have unknown finances and
              unverified operational readiness; no financial or provider records
              are created by this import.
            </label>
          )}
          {batch.status === "reviewed" && (
            <Button
              disabled={busy || dirty || !confirmed}
              onClick={() =>
                void run(async () =>
                  saved(
                    await operation(
                      `/active-job-imports/${batch.id}/approve`,
                      "POST",
                      {
                        revision: batch.revision,
                        reviewFingerprint: batch.reviewFingerprint,
                        confirmNoFinancialOrOperationalSideEffects: true,
                      },
                    ),
                  ),
                )
              }
            >
              Approve saved review
            </Button>
          )}
          {batch.status === "approved" && (
            <Button
              disabled={busy || !confirmed || !batch.approval}
              onClick={() =>
                void run(async () => {
                  saved(
                    await operation(
                      `/active-job-imports/${batch.id}/commit`,
                      "POST",
                      {
                        revision: batch.revision,
                        approvalId: batch.approval!.id,
                        approvalFingerprint: batch.approval!.fingerprint,
                        confirmNoFinancialOrOperationalSideEffects: true,
                      },
                    ),
                  );
                  await refresh();
                })
              }
            >
              Commit approved operational records
            </Button>
          )}
          {batch.result && (
            <div role="status">
              <p>
                {batch.result.created} created · {batch.result.linked} linked
                unchanged · {batch.result.skipped} skipped.
              </p>
              {batch.result.jobIds.map((id) => (
                <Link
                  key={id}
                  href={`/jobs/${encodeURIComponent(id)}`}
                  className="mr-3 text-primary underline"
                >
                  Open Works job
                </Link>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
