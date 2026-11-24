import { useRef, useState } from "react";
import type {
  SupplierContact,
  SupplierImportBatch,
  SupplierImportDecision,
} from "@workspace/domain";
import { useAuth } from "@/contexts/auth";
import { operation, useOperation } from "@/lib/operations";
import { readSupplierCsv, type SupplierList } from "@/lib/supplier-contacts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function SupplierContactImport({
  onClose,
  onCommitted,
}: {
  onClose(): void;
  onCommitted(): void;
}) {
  const { user } = useAuth(),
    allowed = user?.role === "owner" && !user.previewRole;
  const history = useOperation<
    {
      id: string;
      sourceSystem: string;
      batchKey: string;
      fileName: string;
      status: string;
    }[]
  >("/supplier-imports", allowed ? ["owner"] : []);
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const directory = useOperation<SupplierList>(
    `/suppliers?active=active&page=${page}&q=${encodeURIComponent(search)}`,
    allowed ? ["owner"] : [],
  );
  const [sourceSystem, setSourceSystem] = useState(""),
    [batchKey, setBatchKey] = useState(""),
    [fileName, setFileName] = useState("Pasted supplier contacts.csv"),
    [csv, setCsv] = useState(""),
    [delimiter, setDelimiter] = useState<"," | "\t">(",");
  const [batch, setBatch] = useState<SupplierImportBatch | null>(null),
    [decisions, setDecisions] = useState<
      Record<number, Partial<SupplierImportDecision>>
    >({}),
    [targets, setTargets] = useState<Record<string, SupplierContact>>({}),
    [note, setNote] = useState(""),
    [dirty, setDirty] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const inFlight = useRef(false);
  const load = (value: SupplierImportBatch) => {
    setBatch(value);
    setDecisions(
      Object.fromEntries(
        value.decisions.map((choice) => [choice.line, choice]),
      ),
    );
    setTargets(
      Object.fromEntries(
        value.decisions.flatMap((choice) =>
          choice.supplierSnapshot
            ? [[choice.supplierSnapshot.id, choice.supplierSnapshot]]
            : [],
        ),
      ),
    );
    setNote(value.reviewNote ?? "");
    setDirty(false);
    setConfirmed(false);
  };
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current || !allowed) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The supplier import could not finish. Saved records are preserved.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const act = (name: string, body: unknown) =>
    run(async () => {
      const value = await operation<SupplierImportBatch>(
        `/supplier-imports/${batch!.id}/${name}`,
        "POST",
        body,
      );
      load(value);
      if (value.status === "committed") {
        onCommitted();
        void history.refetch();
        void directory.refetch();
      }
    });
  const change = (line: number, value: Partial<SupplierImportDecision>) => {
    setDecisions((old) => ({ ...old, [line]: { ...old[line], ...value } }));
    setDirty(true);
    setConfirmed(false);
  };
  const canReview =
    batch &&
    note.trim().length >= 5 &&
    batch.rows.every((row) => {
      const choice = decisions[row.line];
      if (!choice?.action) return false;
      if (choice.action === "skip")
        return (choice.note ?? "").trim().length >= 5;
      if (row.errors.length || row.imported || row.fileDuplicates.length)
        return false;
      if (choice.action === "link")
        return (
          !!choice.supplierId &&
          !!choice.supplierRevision &&
          (choice.note ?? "").trim().length >= 5
        );
      return (
        !row.candidates.some((candidate) =>
          candidate.reasons.includes("name"),
        ) &&
        (!(
          row.candidates.length ||
          row.legacyNames.length ||
          row.nameDuplicates.length
        ) ||
          (choice.note ?? "").trim().length >= 5)
      );
    });
  if (!allowed) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-auto">
        <DialogHeader>
          <DialogTitle>Import supplier contacts</DialogTitle>
          <DialogDescription>
            Review creates or explicit links only. Linking never overwrites
            active contacts or changes canonical supplier names, product
            mappings, prices, stock or accounting. No messages are sent.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!batch ? (
          <div className="space-y-3">
            <a
              href="/api/supplier-imports/template"
              download
              className="underline"
            >
              Download supplier contact template
            </a>
            <label className="block">
              Source system ID
              <Input
                maxLength={80}
                disabled={busy}
                value={sourceSystem}
                onChange={(event) => setSourceSystem(event.target.value)}
              />
            </label>
            <label className="block">
              Source batch ID
              <Input
                maxLength={120}
                disabled={busy}
                value={batchKey}
                onChange={(event) => setBatchKey(event.target.value)}
              />
            </label>
            <label className="block">
              Source file label
              <Input
                maxLength={200}
                disabled={busy}
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
              />
            </label>
            <label className="block">
              Choose supplier CSV or TSV
              <input
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void run(async () => {
                    setCsv("");
                    setFileName("");
                    setDelimiter(",");
                    const text = await readSupplierCsv(file);
                    setCsv(text);
                    setFileName(file.name);
                    setDelimiter(
                      file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
                    );
                  });
                }}
              />
            </label>
            <label className="block">
              Separator
              <select
                disabled={busy}
                value={delimiter}
                onChange={(event) =>
                  setDelimiter(event.target.value as "," | "\t")
                }
              >
                <option value=",">Comma</option>
                <option value={"\t"}>Tab</option>
              </select>
            </label>
            <label className="block">
              Paste supplier data
              <Textarea
                rows={7}
                disabled={busy}
                value={csv}
                onChange={(event) => setCsv(event.target.value)}
              />
            </label>
            <p className="text-sm text-muted-foreground">
              UTF-8, up to 1 MiB and 200 rows. source_id and name are required.
              Preserve leading-zero source IDs; no accounting or opening-balance
              columns.
            </p>
            <Button
              disabled={
                busy ||
                !csv ||
                !fileName.trim() ||
                !sourceSystem.trim() ||
                !batchKey.trim()
              }
              onClick={() =>
                void run(async () =>
                  load(
                    await operation<SupplierImportBatch>(
                      "/supplier-imports/preview",
                      "POST",
                      {
                        sourceSystem: sourceSystem.trim(),
                        batchKey: batchKey.trim(),
                        fileName: fileName.trim(),
                        csv,
                        delimiter,
                      },
                    ),
                  ),
                )
              }
            >
              Save supplier preview
            </Button>
            <section aria-label="Saved supplier imports">
              <h3>Saved source batches</h3>
              {history.isError ? (
                <p role="alert">Source batches could not load.</p>
              ) : (
                history.data?.map((item) => (
                  <Button
                    key={item.id}
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        load(
                          await operation<SupplierImportBatch>(
                            `/supplier-imports/${item.id}`,
                          ),
                        ),
                      )
                    }
                  >
                    {item.sourceSystem} / {item.batchKey} · {item.status}
                  </Button>
                ))
              )}
            </section>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold">
                {batch.sourceSystem} / {batch.batchKey}
              </h3>
              <p>
                {batch.fileName} · {batch.status}
              </p>
              <p className="break-all text-xs">
                Source SHA-256: {batch.sourceSha256}
              </p>
              <a
                href={`/api/supplier-imports/${encodeURIComponent(batch.id)}/source`}
                download
                className="underline"
              >
                Download retained original source
              </a>
            </div>
            <div className="flex flex-wrap gap-2">
              {batch.status !== "committed" && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act("refresh", { revision: batch.revision })
                  }
                >
                  Refresh matches and start a new review
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBatch(null);
                  setError("");
                  setConfirmed(false);
                }}
              >
                Choose another batch
              </Button>
            </div>
            {["preview", "reviewed"].includes(batch.status) && (
              <section className="space-y-2 rounded border p-3">
                <label className="block">
                  Find an existing supplier to link
                  <Input
                    value={search}
                    maxLength={80}
                    disabled={busy}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <p className="text-xs">
                  Name and contact matches are suggestions only. Select the
                  intended active supplier explicitly; imported source names
                  never become bill or SKU aliases.
                </p>
                {directory.isError && (
                  <p role="alert">
                    Supplier choices could not load. Refresh before selecting a
                    supplier.
                  </p>
                )}
                <Button
                  variant="outline"
                  disabled={busy || page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous supplier choices
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !directory.data?.hasMore}
                  onClick={() => setPage(page + 1)}
                >
                  More supplier choices
                </Button>
              </section>
            )}
            {batch.rows.map((row) => {
              const choice = decisions[row.line],
                editable = ["preview", "reviewed"].includes(batch.status),
                blocked =
                  !!row.errors.length ||
                  !!row.imported ||
                  !!row.fileDuplicates.length;
              const options = [
                ...new Map(
                  [
                    ...row.candidates,
                    ...(directory.isError
                      ? []
                      : (directory.data?.suppliers ?? [])),
                    ...(choice?.supplierId && targets[choice.supplierId]
                      ? [targets[choice.supplierId]]
                      : []),
                  ].map((supplier) => [supplier.id, supplier]),
                ).values(),
              ];
              return (
                <section
                  key={row.line}
                  className="space-y-2 rounded border p-3 text-sm"
                >
                  <h4 className="font-semibold">
                    Line {row.line}: {row.data.name || "Missing supplier name"}
                  </h4>
                  <p>Source ID: {row.data.sourceId || "missing"}</p>
                  <p>
                    Source contact: {row.data.contactName || "Not recorded"} ·{" "}
                    {row.data.email || "No email"} ·{" "}
                    {row.data.phone || "No phone"}
                  </p>
                  <p>
                    {[
                      row.data.address,
                      row.data.city,
                      row.data.state,
                      row.data.postalCode,
                      row.data.country,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  {row.data.notes && (
                    <p className="whitespace-pre-wrap">{row.data.notes}</p>
                  )}
                  {row.errors.map((message) => (
                    <p key={message} className="text-destructive">
                      {message}
                    </p>
                  ))}
                  {row.imported && (
                    <p>
                      This source ID is already bound. Skip it; source
                      identities cannot be rebound.
                    </p>
                  )}
                  {!!row.fileDuplicates.length && (
                    <p>
                      Duplicate source ID also appears on lines{" "}
                      {row.fileDuplicates.join(", ")}.
                    </p>
                  )}
                  {!!row.nameDuplicates.length && (
                    <p>
                      Same supplier name also appears on lines{" "}
                      {row.nameDuplicates.join(", ")}; multiple new identities
                      cannot share a canonical name.
                    </p>
                  )}
                  {!!row.legacyNames.length && (
                    <p>
                      Existing purchase or product labels:{" "}
                      {row.legacyNames.join("; ")}. These labels will remain
                      unchanged.
                    </p>
                  )}
                  {row.candidates.map((candidate) => (
                    <p key={candidate.id}>
                      Possible {candidate.reasons.join(" / ")} match:{" "}
                      {candidate.name} ·{" "}
                      {candidate.email ||
                        candidate.phone ||
                        "No contact recorded"}{" "}
                      ·{" "}
                      {candidate.active
                        ? "Active"
                        : "Inactive; reactivate before linking"}
                    </p>
                  ))}
                  {editable ? (
                    <>
                      <label className="block">
                        Decision for line {row.line}
                        <select
                          disabled={busy}
                          value={choice?.action ?? ""}
                          onChange={(event) =>
                            change(row.line, {
                              action: event.target
                                .value as SupplierImportDecision["action"],
                              supplierId: undefined,
                              supplierRevision: undefined,
                            })
                          }
                        >
                          <option value="">Choose explicitly</option>
                          <option
                            value="create"
                            disabled={
                              blocked ||
                              row.candidates.some((candidate) =>
                                candidate.reasons.includes("name"),
                              )
                            }
                          >
                            Create new supplier
                          </option>
                          <option value="link" disabled={blocked}>
                            Link existing supplier without overwrite
                          </option>
                          <option value="skip">Skip source row</option>
                        </select>
                      </label>
                      {choice?.action === "link" && (
                        <label className="block">
                          Existing supplier for line {row.line}
                          <select
                            disabled={busy}
                            value={choice.supplierId ?? ""}
                            onChange={(event) => {
                              const selected = options.find(
                                (supplier) =>
                                  supplier.id === event.target.value,
                              );
                              if (selected) {
                                setTargets((old) => ({
                                  ...old,
                                  [selected.id]: selected,
                                }));
                                change(row.line, {
                                  supplierId: selected.id,
                                  supplierRevision: selected.revision,
                                });
                              }
                            }}
                          >
                            <option value="">
                              Choose the intended supplier
                            </option>
                            {options.map((supplier) => (
                              <option
                                key={supplier.id}
                                value={supplier.id}
                                disabled={!supplier.active}
                              >
                                {supplier.name} ·{" "}
                                {supplier.email ||
                                  supplier.phone ||
                                  "No contact recorded"}{" "}
                                · revision {supplier.revision}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="block">
                        Review reason for line {row.line}
                        <Input
                          maxLength={500}
                          disabled={busy}
                          value={choice?.note ?? ""}
                          onChange={(event) =>
                            change(row.line, { note: event.target.value })
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <p>
                      Accepted decision: {choice?.action}{" "}
                      {choice?.supplierSnapshot
                        ? `· ${choice.supplierSnapshot.name} at revision ${choice.supplierRevision}`
                        : ""}{" "}
                      · {choice?.note}
                    </p>
                  )}
                </section>
              );
            })}
            {["preview", "reviewed"].includes(batch.status) && (
              <>
                <label className="block">
                  Batch review note
                  <Textarea
                    maxLength={1000}
                    disabled={busy}
                    value={note}
                    onChange={(event) => {
                      setNote(event.target.value);
                      setDirty(true);
                      setConfirmed(false);
                    }}
                  />
                </label>
                <Button
                  disabled={busy || !canReview}
                  onClick={() =>
                    void act("review", {
                      revision: batch.revision,
                      previewFingerprint: batch.previewFingerprint,
                      note: note.trim(),
                      decisions: batch.rows.map((row) => {
                        const choice = decisions[row.line]!;
                        return {
                          line: row.line,
                          action: choice.action,
                          note: choice.note?.trim() ?? "",
                          ...(choice.action === "link"
                            ? {
                                supplierId: choice.supplierId,
                                supplierRevision: choice.supplierRevision,
                              }
                            : {}),
                        };
                      }),
                    })
                  }
                >
                  Save supplier review
                </Button>
              </>
            )}
            {["reviewed", "approved"].includes(batch.status) && (
              <>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy || dirty}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I reviewed the exact saved decisions. This changes supplier
                  contacts/source links only and does not import stock, prices,
                  orders or accounting balances.
                </label>
                {dirty && <p>Save the changed review before approving it.</p>}
                {batch.status === "reviewed" ? (
                  <Button
                    disabled={busy || dirty || !confirmed}
                    onClick={() =>
                      void act("approve", {
                        revision: batch.revision,
                        reviewFingerprint: batch.reviewFingerprint,
                        confirmContactsOnly: true,
                      })
                    }
                  >
                    Record owner approval
                  </Button>
                ) : (
                  <Button
                    disabled={busy || !confirmed}
                    onClick={() =>
                      void act("commit", {
                        revision: batch.revision,
                        approvalId: batch.approval!.id,
                        approvalFingerprint: batch.approval!.fingerprint,
                        confirmContactsOnly: true,
                      })
                    }
                  >
                    Commit approved supplier import
                  </Button>
                )}
              </>
            )}
            {batch.status === "committed" && batch.result && (
              <p role="status">
                Supplier import saved: {batch.result.created} created,{" "}
                {batch.result.linked} linked without overwrite,{" "}
                {batch.result.skipped} skipped.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
