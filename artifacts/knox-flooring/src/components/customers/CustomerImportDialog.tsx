import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  customerImportFields,
  customerImportMaxBytes,
  type CustomerImportBatch,
  type CustomerImportDecision,
  type CustomerImportMapping,
} from "@workspace/domain";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  operation,
  useOperation,
  useRefreshOperations,
} from "@/lib/operations";

interface Summary {
  id: string;
  sourceSystem: string;
  batchKey: string;
  status: string;
}
export function CustomerImportDialog({ onClose }: { onClose(): void }) {
  const refresh = useRefreshOperations();
  const history = useOperation<Summary[]>("/customer-imports", ["owner"]);
  const [csv, setCsv] = useState("");
  const [delimiter, setDelimiter] = useState<"," | "\t">(",");
  const [sourceSystem, setSource] = useState("");
  const [batchKey, setBatchKey] = useState("");
  const [fileName, setFileName] = useState("Pasted customer data.csv");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<CustomerImportMapping>({});
  const [batch, setBatch] = useState<CustomerImportBatch | null>(null);
  const [decisions, setDecisions] = useState<
    Record<number, Partial<CustomerImportDecision>>
  >({});
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const load = (value: CustomerImportBatch) => {
    setBatch(value);
    setConfirmed(false);
    setReviewDirty(false);
    setNote(value.reviewNote ?? "");
    setDecisions(
      Object.fromEntries(value.decisions.map((item) => [item.line, item])),
    );
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The import could not be completed. Saved records are preserved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const editCsv = (value: string) => {
    version.current++;
    setCsv(value);
    setHeaders([]);
    setMapping({});
    setError("");
  };
  const action = (name: string, body: unknown) =>
    run(async () => {
      const value = await operation<CustomerImportBatch>(
        `/customer-imports/${batch!.id}/${name}`,
        "POST",
        body,
      );
      load(value);
      await refresh();
    });
  const canReview =
    batch &&
    batch.rows.every((row) => decisions[row.line]?.action) &&
    note.trim().length >= 5;
  const counts = (batch?.decisions ?? []).reduce(
    (result, item) => {
      result[item.action]++;
      return result;
    },
    { create: 0, link: 0, skip: 0 },
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import customer records</DialogTitle>
          <DialogDescription>
            Review contact records and source identities before saving. Linking
            keeps existing customer details; it does not merge or overwrite
            them.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p
            role="alert"
            className="rounded border border-destructive/30 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {!batch ? (
          <div className="space-y-4">
            {history.data?.length ? (
              <label className="block text-sm">
                Resume a saved batch
                <select
                  aria-label="Resume a saved batch"
                  className="ml-2 rounded border p-2"
                  value=""
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value)
                      void run(async () =>
                        load(
                          await operation<CustomerImportBatch>(
                            `/customer-imports/${event.target.value}`,
                          ),
                        ),
                      );
                  }}
                >
                  <option value="">Choose a saved batch</option>
                  {history.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.sourceSystem} / {item.batchKey} · {item.status}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                Source system ID
                <Input
                  value={sourceSystem}
                  disabled={busy}
                  placeholder="legacy-flooring-system"
                  maxLength={80}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <label className="text-sm">
                Source batch ID
                <Input
                  value={batchKey}
                  disabled={busy}
                  placeholder="customers-2026-11-23-01"
                  maxLength={120}
                  onChange={(event) => setBatchKey(event.target.value)}
                />
              </label>
              <label className="text-sm">
                Source file label
                <Input
                  value={fileName}
                  disabled={busy}
                  maxLength={200}
                  onChange={(event) => setFileName(event.target.value)}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Use a stable ID from the source system for each customer. Source
              IDs keep leading zeroes. Reusing a source/batch ID with a
              different file is refused.
            </p>
            <div className="flex flex-wrap gap-3">
              <label className="text-sm">
                Choose CSV or TSV
                <input
                  aria-label="Choose customer CSV"
                  className="ml-2"
                  type="file"
                  accept=".csv,.tsv,text/csv,text/tab-separated-values"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    if (file.size > customerImportMaxBytes) {
                      setError("Use a file of 200 KB or less.");
                      return;
                    }
                    editCsv("");
                    const expected = version.current;
                    setFileName(file.name);
                    void run(async () => {
                      const text = await file.text();
                      if (version.current === expected) {
                        setCsv(text);
                        setDelimiter(
                          file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
                        );
                      }
                    });
                  }}
                />
              </label>
              <label className="text-sm">
                Separator
                <select
                  aria-label="Separator"
                  className="ml-2 rounded border p-1"
                  value={delimiter}
                  disabled={busy}
                  onChange={(event) => {
                    setDelimiter(event.target.value as "," | "\t");
                    setHeaders([]);
                    setMapping({});
                  }}
                >
                  <option value=",">Comma (CSV)</option>
                  <option value={"\t"}>Tab (paste/TSV)</option>
                </select>
              </label>
            </div>
            <label className="block text-sm">
              Paste customer data
              <Textarea
                aria-label="Paste customer data"
                rows={7}
                disabled={busy}
                value={csv}
                onChange={(event) => editCsv(event.target.value)}
                placeholder={
                  "External ID,Customer,Email\nFICTIONAL-001,Fictional Sample Household,sample@example.invalid"
                }
              />
            </label>
            <Button
              disabled={busy || !csv.trim()}
              onClick={() =>
                void run(async () => {
                  const inspected = await operation<{ headers: string[] }>(
                    "/customer-imports/inspect",
                    "POST",
                    { csv, delimiter },
                  );
                  setHeaders(inspected.headers);
                  setMapping({});
                })
              }
            >
              Read columns
            </Button>
            {headers.length > 0 && (
              <>
                <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-3">
                  <legend className="mb-2 text-sm font-medium">
                    Review field mapping
                  </legend>
                  {customerImportFields.map((field) => (
                    <label key={field} className="text-sm">
                      {field === "sourceId"
                        ? "Source customer ID (required)"
                        : field === "name"
                          ? "Customer name (required)"
                          : field}
                      <select
                        aria-label={`Map ${field}`}
                        className="block w-full rounded border bg-background p-2"
                        value={mapping[field] ?? ""}
                        onChange={(event) =>
                          setMapping((previous) => {
                            const next = { ...previous };
                            if (event.target.value)
                              next[field] = event.target.value;
                            else delete next[field];
                            return next;
                          })
                        }
                      >
                        <option value="">
                          {field === "sourceId" || field === "name"
                            ? "Choose a column"
                            : "Do not import"}
                        </option>
                        {headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </fieldset>
                <Button
                  disabled={
                    busy ||
                    !sourceSystem ||
                    !batchKey ||
                    !fileName ||
                    !mapping.sourceId ||
                    !mapping.name
                  }
                  onClick={() =>
                    void run(async () =>
                      load(
                        await operation<CustomerImportBatch>(
                          "/customer-imports/preview",
                          "POST",
                          {
                            csv,
                            delimiter,
                            mapping,
                            sourceSystem,
                            batchKey,
                            fileName,
                          },
                        ),
                      ),
                    )
                  }
                >
                  Save preview
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded border p-3 text-sm">
              <p className="font-medium">
                {batch.sourceSystem} / {batch.batchKey} · {batch.status}
              </p>
              <p>
                {batch.fileName} · {batch.rows.length} source rows
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Source SHA-256: {batch.sourceSha256}
              </p>
              <p className="mt-2 text-xs">
                {Object.entries(batch.mapping)
                  .map(([field, column]) => `${column} → ${field}`)
                  .join(" · ")}
              </p>
            </div>
            {batch.status !== "committed" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action("refresh", { revision: batch.revision })
                }
              >
                Refresh matches and review again
              </Button>
            )}
            {(batch.status === "approved" || batch.status === "committed") && (
              <details className="rounded border p-3" open>
                <summary className="cursor-pointer font-medium">
                  Approved customer decisions
                </summary>
                <p className="my-2 text-sm">{batch.reviewNote}</p>
                {batch.rows.map((row) => {
                  const decision = batch.decisions.find(
                    (item) => item.line === row.line,
                  );
                  return (
                    <div key={row.line} className="border-t py-2 text-sm">
                      <p>
                        Line {row.line}: {row.data.name} · Source ID{" "}
                        {row.data.sourceId}
                      </p>
                      <p>
                        {row.data.email} {row.data.phone}
                      </p>
                      <p>
                        {decision?.action === "create"
                          ? "Create a separate customer"
                          : decision?.action === "link"
                            ? `Link source identity to existing customer ${decision.customerId}`
                            : "Skip source row"}
                      </p>
                      {decision?.note && <p>{decision.note}</p>}
                    </div>
                  );
                })}
              </details>
            )}
            {(batch.status === "preview" || batch.status === "reviewed") && (
              <>
                <div className="space-y-3">
                  {batch.rows.map((row) => {
                    const decision = decisions[row.line];
                    const value =
                      decision?.action === "link"
                        ? `link:${decision.customerId}`
                        : (decision?.action ?? "");
                    return (
                      <section
                        key={row.line}
                        className="rounded border p-3 text-sm"
                      >
                        <p className="font-medium">
                          Line {row.line}: {row.data.name || "Missing name"} ·
                          Source ID {row.data.sourceId || "missing"}
                        </p>
                        <p>
                          {row.data.email} {row.data.phone}
                        </p>
                        {row.data.address && (
                          <p>
                            {[
                              row.data.address,
                              row.data.city,
                              row.data.state,
                              row.data.zip,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </p>
                        )}
                        {row.errors.map((message) => (
                          <p key={message} className="text-destructive">
                            {message}
                          </p>
                        ))}
                        {row.imported && (
                          <p>
                            Already imported. Original customer{" "}
                            {row.imported.customerId}; current customer{" "}
                            {row.imported.effectiveCustomerId}. This source ID
                            will not create another customer.
                          </p>
                        )}
                        {row.fileDuplicates.length > 0 && (
                          <p>
                            Possible matches within this file: lines{" "}
                            {row.fileDuplicates.join(", ")}.
                          </p>
                        )}
                        {row.candidates.length > 0 && (
                          <ul className="my-2 text-muted-foreground">
                            {row.candidates.map((candidate) => (
                              <li key={candidate.id}>
                                {candidate.name} ·{" "}
                                {candidate.email || candidate.phone} · existing
                                ID {candidate.id}
                              </li>
                            ))}
                          </ul>
                        )}
                        <label className="block">
                          Decision for line {row.line}
                          <select
                            aria-label={`Decision for line ${row.line}`}
                            className="ml-2 max-w-full rounded border bg-background p-2"
                            value={value}
                            disabled={busy}
                            onChange={(event) => {
                              setReviewDirty(true);
                              const selected = event.target.value;
                              const candidate = row.candidates.find(
                                (item) => selected === `link:${item.id}`,
                              );
                              setDecisions((previous) => ({
                                ...previous,
                                [row.line]: {
                                  line: row.line,
                                  ...(selected.startsWith("link:")
                                    ? {
                                        action: "link",
                                        customerId: candidate!.id,
                                        customerRevision: candidate!.revision,
                                      }
                                    : selected
                                      ? {
                                          action: selected as "create" | "skip",
                                        }
                                      : {}),
                                  note: previous[row.line]?.note ?? "",
                                },
                              }));
                              setConfirmed(false);
                            }}
                          >
                            <option value="">Choose explicitly</option>
                            <option value="skip">Skip this source row</option>
                            {!row.errors.length && !row.imported && (
                              <>
                                <option value="create">
                                  Create a separate customer
                                </option>
                                {row.candidates.map((candidate) => (
                                  <option
                                    key={candidate.id}
                                    value={`link:${candidate.id}`}
                                  >
                                    Link to {candidate.name} ({candidate.id})
                                  </option>
                                ))}
                              </>
                            )}
                          </select>
                        </label>
                        <label className="mt-2 block">
                          Review note for line {row.line}
                          <Input
                            aria-label={`Review note for line ${row.line}`}
                            maxLength={500}
                            disabled={busy}
                            value={decision?.note ?? ""}
                            onChange={(event) => {
                              setReviewDirty(true);
                              setConfirmed(false);
                              const note = event.target.value;
                              setDecisions((previous) => ({
                                ...previous,
                                [row.line]: {
                                  ...previous[row.line],
                                  line: row.line,
                                  note,
                                },
                              }));
                            }}
                            placeholder="Explain links, skipped rows and separate customers despite matches"
                          />
                        </label>
                      </section>
                    );
                  })}
                </div>
                <label className="block text-sm">
                  Batch review note
                  <Textarea
                    aria-label="Batch review note"
                    maxLength={1000}
                    disabled={busy}
                    value={note}
                    onChange={(event) => {
                      setReviewDirty(true);
                      setNote(event.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <Button
                  disabled={busy || !canReview}
                  onClick={() =>
                    void action("review", {
                      revision: batch.revision,
                      previewFingerprint: batch.previewFingerprint,
                      note,
                      decisions: batch.rows.map((row) => decisions[row.line]),
                    })
                  }
                >
                  Save row decisions
                </Button>
              </>
            )}
            {batch.status === "reviewed" && (
              <section className="space-y-3 rounded border p-3">
                <p>
                  Saved review: {counts.create} create · {counts.link} link ·{" "}
                  {counts.skip} skip.
                </p>
                <p>{batch.reviewNote}</p>
                {reviewDirty && (
                  <p>Save changed row decisions before approving.</p>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I approve these exact saved decisions. Customer links keep
                  existing details unchanged.
                </label>
                <Button
                  disabled={busy || !confirmed || reviewDirty}
                  onClick={() =>
                    void action("approve", {
                      revision: batch.revision,
                      reviewFingerprint: batch.reviewFingerprint,
                      confirm: true,
                    })
                  }
                >
                  Approve reviewed import
                </Button>
              </section>
            )}
            {batch.status === "approved" && (
              <section className="space-y-3 rounded border p-3">
                <p>
                  Immutable approval saved. {counts.create} customers will be
                  created, {counts.link} source identities linked, and{" "}
                  {counts.skip} rows skipped.
                </p>
                <p className="break-all text-xs">
                  Approval: {batch.approval?.fingerprint}
                </p>
                <Button
                  disabled={busy || !batch.approval}
                  onClick={() =>
                    void action("commit", {
                      revision: batch.revision,
                      approvalId: batch.approval!.id,
                      approvalFingerprint: batch.approval!.fingerprint,
                    })
                  }
                >
                  Commit approved customer import
                </Button>
              </section>
            )}
            {batch.status === "committed" && batch.result && (
              <section role="status" className="rounded border p-3">
                <p>
                  Import committed: {batch.result.created} created ·{" "}
                  {batch.result.linked} linked · {batch.result.skipped} skipped.
                </p>
                <p className="text-sm">
                  Replaying this batch will return the same result. Source
                  identities and approval history are retained.
                </p>
                {batch.result.customerIds.map((id) => (
                  <Link
                    key={id}
                    className="mr-3 text-sm underline"
                    href={`/customers/${encodeURIComponent(id)}`}
                  >
                    Open customer {id}
                  </Link>
                ))}
              </section>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBatch(null);
                setHeaders([]);
                setMapping({});
                setCsv("");
                setBatchKey("");
                setConfirmed(false);
              }}
            >
              Choose another batch
            </Button>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
