import { useRef, useState } from "react";
import {
  legacyArchiveMaxBytes,
  type LegacyArchiveBatch,
  type LegacyArchiveDecision,
} from "@workspace/domain";
import { useAuth } from "@/contexts/auth";
import { operation, useOperation } from "@/lib/operations";
import {
  legacyArchiveLabel,
  readLegacyCsv,
  type LegacyArchiveImportSummary,
} from "@/lib/legacy-history";
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

export function LegacyArchiveImport({
  onClose,
  onCommitted,
}: {
  onClose(): void;
  onCommitted(): void;
}) {
  const { user } = useAuth();
  const allowed = user?.role === "owner" && !user.previewRole;
  const history = useOperation<LegacyArchiveImportSummary[]>(
    "/legacy-history/imports",
    allowed ? ["owner"] : [],
  );
  const [csv, setCsv] = useState("");
  const [delimiter, setDelimiter] = useState<"," | "\t">(",");
  const [sourceSystem, setSource] = useState("");
  const [batchKey, setBatchKey] = useState("");
  const [fileName, setFileName] = useState("Pasted history.csv");
  const [batch, setBatch] = useState<LegacyArchiveBatch | null>(null);
  const [decisions, setDecisions] = useState<
    Record<number, Partial<LegacyArchiveDecision>>
  >({});
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const load = (value: LegacyArchiveBatch) => {
    setBatch(value);
    setConfirmed(false);
    setDirty(false);
    setNote(value.reviewNote ?? "");
    setDecisions(
      Object.fromEntries(value.decisions.map((item) => [item.line, item])),
    );
  };
  async function run(work: () => Promise<void>) {
    if (!allowed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The archive action could not be completed. Reload the saved batch before retrying.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function act(
    name: "refresh" | "review" | "approve" | "commit",
    body: unknown,
  ) {
    if (!batch) return;
    void run(async () => {
      const saved = await operation<LegacyArchiveBatch>(
        `/legacy-history/imports/${encodeURIComponent(batch.id)}/${name}`,
        "POST",
        body,
      );
      load(saved);
      void history.refetch();
      if (saved.status === "committed") onCommitted();
    });
  }
  function changeDecision(
    line: number,
    update: Partial<LegacyArchiveDecision>,
  ) {
    setDirty(true);
    setConfirmed(false);
    setDecisions((previous) => ({
      ...previous,
      [line]: { ...previous[line], ...update, line },
    }));
  }
  const canReview =
    !!batch &&
    note.trim().length >= 5 &&
    batch.rows.every((row) => {
      const decision = decisions[row.line];
      return decision?.action === "skip"
        ? (decision.note?.trim().length ?? 0) >= 5
        : decision?.action === "archive" &&
            !row.errors.length &&
            !row.existing &&
            !row.fileDuplicates.length;
    });
  const counts = (batch?.decisions ?? []).reduce(
    (result, item) => {
      result[item.action]++;
      return result;
    },
    { archive: 0, skip: 0 },
  );
  if (!allowed) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import historical records</DialogTitle>
          <DialogDescription>
            This saves a private, read-only archive. Historical jobs, quotes,
            invoices and payments never become active jobs, accounting balances,
            stock movements or customer links.
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
            <div className="flex flex-wrap gap-3 text-sm">
              <a
                className="underline"
                href="/api/legacy-history/template"
                download
              >
                Download version 1 CSV headers
              </a>
            </div>
            <p className="text-sm text-muted-foreground">
              Use source_id, type and title columns. Optional columns:
              reference, party_name, occurred_on, status, summary. Import up to
              200 rows / 1 MiB. Dates use YYYY-MM-DD; leave unknown dates blank.
              Source IDs stay text, including leading zeros.
            </p>
            {history.isError && (
              <p role="alert">
                Saved import batches could not load.{" "}
                <button
                  className="underline"
                  onClick={() => void history.refetch()}
                >
                  Retry
                </button>
              </p>
            )}
            {!!history.data?.length && (
              <label className="block space-y-1 text-sm">
                Resume a saved history batch
                <select
                  className="h-11 w-full rounded border bg-background px-3"
                  value=""
                  disabled={busy}
                  onChange={(event) => {
                    const id = event.target.value;
                    if (id)
                      void run(async () =>
                        load(
                          await operation<LegacyArchiveBatch>(
                            `/legacy-history/imports/${encodeURIComponent(id)}`,
                          ),
                        ),
                      );
                  }}
                >
                  <option value="">Choose a saved batch…</option>
                  {history.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.sourceSystem} / {item.batchKey} · {item.status}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-sm">
                Source system ID
                <Input
                  value={sourceSystem}
                  disabled={busy}
                  maxLength={80}
                  placeholder="legacy-system"
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                Source batch ID
                <Input
                  value={batchKey}
                  disabled={busy}
                  maxLength={120}
                  onChange={(event) => setBatchKey(event.target.value)}
                />
              </label>
              <label className="space-y-1 text-sm">
                Source file label
                <Input
                  value={fileName}
                  disabled={busy}
                  maxLength={200}
                  onChange={(event) => setFileName(event.target.value)}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                Choose history CSV or TSV
                <input
                  className="ml-2 max-w-full"
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
                      const text = await readLegacyCsv(file);
                      setCsv(text);
                      setFileName(file.name);
                      setDelimiter(
                        file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
                      );
                    });
                  }}
                />
              </label>
              <label className="text-sm">
                Separator
                <select
                  className="ml-2 rounded border bg-background p-2"
                  disabled={busy}
                  value={delimiter}
                  onChange={(event) =>
                    setDelimiter(event.target.value as "," | "\t")
                  }
                >
                  <option value=",">Comma (CSV)</option>
                  <option value={"\t"}>Tab (TSV/paste)</option>
                </select>
              </label>
            </div>
            <label className="block space-y-1 text-sm">
              Paste historical data
              <Textarea
                rows={7}
                value={csv}
                disabled={busy}
                onChange={(event) => {
                  setCsv(event.target.value);
                  setError("");
                }}
                placeholder="source_id,type,title,reference,party_name,occurred_on,status,summary"
              />
            </label>
            <Button
              disabled={
                busy ||
                !csv.trim() ||
                !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(sourceSystem) ||
                !batchKey.trim() ||
                !fileName.trim()
              }
              onClick={() =>
                void run(async () => {
                  if (new Blob([csv]).size > legacyArchiveMaxBytes)
                    throw new Error("Use historical data up to 1 MiB.");
                  load(
                    await operation<LegacyArchiveBatch>(
                      "/legacy-history/imports/preview",
                      "POST",
                      {
                        sourceSystem,
                        batchKey: batchKey.trim(),
                        fileName: fileName.trim(),
                        csv,
                        delimiter,
                      },
                    ),
                  );
                  void history.refetch();
                })
              }
            >
              {busy ? "Reading history…" : "Save archive preview"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1 rounded border p-3 text-sm">
              <p className="font-semibold">
                {batch.sourceSystem} / {batch.batchKey} · {batch.status}
              </p>
              <p>
                {batch.fileName} · {batch.rows.length} source rows
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Original source SHA-256: {batch.sourceSha256}
              </p>
              <a
                className="inline-block underline"
                href={`/api/legacy-history/imports/${encodeURIComponent(batch.id)}/source`}
                download
              >
                Download original source CSV
              </a>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    load(
                      await operation<LegacyArchiveBatch>(
                        `/legacy-history/imports/${encodeURIComponent(batch.id)}`,
                      ),
                    ),
                  )
                }
              >
                Reload saved batch
              </Button>
              {batch.status !== "committed" && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => act("refresh", { revision: batch.revision })}
                >
                  Refresh identities and review again
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBatch(null);
                  setConfirmed(false);
                  setDirty(false);
                  setError("");
                }}
              >
                Choose another batch
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Each decision applies only to the historical archive. Conflicting
              or already archived source identities cannot be overwritten.
            </p>
            <div className="space-y-3">
              {batch.rows.map((row) => {
                const decision = decisions[row.line];
                const editable = ["preview", "reviewed"].includes(batch.status);
                const blocked =
                  !!row.errors.length ||
                  !!row.existing ||
                  !!row.fileDuplicates.length;
                return (
                  <section
                    key={row.line}
                    className="space-y-2 rounded border p-3 text-sm"
                  >
                    <h3 className="font-semibold">
                      Line {row.line}: {row.data.title || "Missing title"}
                    </h3>
                    <p>
                      {legacyArchiveLabel(row.data.recordType)} · Source ID{" "}
                      {row.data.sourceId || "missing"}
                    </p>
                    <p>
                      Source reference: {row.data.reference || "Not recorded"} ·
                      Source party: {row.data.partyName || "Not recorded"}
                    </p>
                    <p>
                      Historical date: {row.data.occurredOn ?? "Unknown"} ·
                      Source status: {row.data.status || "Not recorded"}
                    </p>
                    {row.data.summary && (
                      <p className="whitespace-pre-wrap break-words">
                        {row.data.summary}
                      </p>
                    )}
                    {row.errors.map((message) => (
                      <p key={message} className="text-destructive">
                        {message}
                      </p>
                    ))}
                    {row.existing && (
                      <p>
                        This source identity is already archived. Its original
                        record and checksum will be retained.
                      </p>
                    )}
                    {!!row.fileDuplicates.length && (
                      <p>
                        Repeated source identity in this file on line(s){" "}
                        {row.fileDuplicates.join(", ")}. Correct the file or
                        explicitly skip the repeated rows.
                      </p>
                    )}
                    {editable ? (
                      <>
                        <label className="block">
                          Decision for line {row.line}
                          <select
                            className="ml-2 rounded border bg-background p-2"
                            value={decision?.action ?? ""}
                            disabled={busy}
                            onChange={(event) =>
                              changeDecision(row.line, {
                                action: event.target
                                  .value as LegacyArchiveDecision["action"],
                              })
                            }
                          >
                            <option value="">Choose explicitly</option>
                            <option value="skip">Skip this source row</option>
                            <option value="archive" disabled={blocked}>
                              Archive as historical only
                            </option>
                          </select>
                        </label>
                        <label className="block space-y-1">
                          Review note for line {row.line}
                          <Input
                            maxLength={500}
                            disabled={busy}
                            value={decision?.note ?? ""}
                            onChange={(event) =>
                              changeDecision(row.line, {
                                note: event.target.value,
                              })
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <p>
                        Approved decision:{" "}
                        {decision?.action === "archive"
                          ? "Archive as historical only"
                          : "Skip source row"}
                        {decision?.note ? ` · ${decision.note}` : ""}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
            {["preview", "reviewed"].includes(batch.status) && (
              <>
                <label className="block space-y-1 text-sm">
                  Batch review note
                  <Textarea
                    disabled={busy}
                    maxLength={1000}
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
                    act("review", {
                      revision: batch.revision,
                      previewFingerprint: batch.previewFingerprint,
                      note: note.trim(),
                      decisions: batch.rows.map((row) => ({
                        ...decisions[row.line],
                        line: row.line,
                        note: decisions[row.line]?.note?.trim() ?? "",
                      })),
                    })
                  }
                >
                  Save archive decisions
                </Button>
              </>
            )}
            {batch.status === "reviewed" && (
              <section className="space-y-3 rounded border p-3 text-sm">
                <p>
                  Saved review: {counts.archive} archive · {counts.skip} skip.
                </p>
                <p>{batch.reviewNote}</p>
                {dirty && <p>Save changed decisions before approving.</p>}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I approve these exact saved decisions for a read-only
                  historical archive. No active jobs, invoices, stock or
                  balances will be created.
                </label>
                <Button
                  disabled={busy || !confirmed || dirty}
                  onClick={() =>
                    act("approve", {
                      revision: batch.revision,
                      reviewFingerprint: batch.reviewFingerprint,
                      confirmReadOnly: true,
                    })
                  }
                >
                  Approve archive-only review
                </Button>
              </section>
            )}
            {batch.status === "approved" && (
              <section className="space-y-3 rounded border p-3 text-sm">
                <p>
                  Immutable owner approval saved: {counts.archive} archive ·{" "}
                  {counts.skip} skip.
                </p>
                <p>{batch.reviewNote}</p>
                <p className="break-all text-xs">
                  Approval SHA-256: {batch.approval?.fingerprint}
                </p>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  Save these approved historical records to the archive only.
                  Active business records and balances remain unchanged.
                </label>
                <Button
                  disabled={busy || !confirmed || !batch.approval}
                  onClick={() =>
                    act("commit", {
                      revision: batch.revision,
                      approvalId: batch.approval!.id,
                      approvalFingerprint: batch.approval!.fingerprint,
                      confirmReadOnly: true,
                    })
                  }
                >
                  Save approved archive
                </Button>
              </section>
            )}
            {batch.status === "committed" && (
              <p role="status" className="rounded border p-3 text-sm">
                Historical archive saved: {batch.result?.archived ?? 0}{" "}
                record(s), {batch.result?.skipped ?? 0} skipped. Active jobs,
                accounting and stock are unchanged.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
