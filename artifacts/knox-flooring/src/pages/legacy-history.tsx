import { useState } from "react";
import {
  legacyArchiveTypes,
  type LegacyArchiveRecord,
} from "@workspace/domain";
import { useAuth } from "@/contexts/auth";
import { useOperation } from "@/lib/operations";
import { useQueryControls, useUrlState } from "@/hooks/use-url-state";
import {
  legacyArchiveLabel,
  type LegacyArchiveDetail,
} from "@/lib/legacy-history";
import { LegacyArchiveImport } from "@/components/legacy-history/LegacyArchiveImport";
import { LegacyArchiveFiles } from "@/components/legacy-history/LegacyArchiveFiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export default function LegacyHistory() {
  const { user } = useAuth();
  const allowed = user?.role === "owner" && !user.previewRole;
  const [selectedId] = useUrlState<string>("record", "");
  const [q] = useUrlState<string>("q", "");
  const [recordType] = useUrlState<string>("type", "");
  const [sourceSystem] = useUrlState<string>("sourceSystem", "");
  const [pageValue] = useUrlState<string>("page", "0");
  const parsedPage = Number(pageValue);
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage >= 0 && parsedPage <= 1000
      ? parsedPage
      : 0;
  const controls = useQueryControls();
  const [search, setSearch] = useState(q);
  const [typeInput, setTypeInput] = useState(recordType);
  const [sourceInput, setSourceInput] = useState(sourceSystem);
  const [importing, setImporting] = useState(false);
  const query = new URLSearchParams({ page: String(page) });
  if (q) query.set("q", q);
  if (recordType) query.set("type", recordType);
  if (sourceSystem) query.set("sourceSystem", sourceSystem);
  const records = useOperation<{
    records: LegacyArchiveRecord[];
    page: number;
    hasMore: boolean;
  }>(`/legacy-history?${query}`, allowed ? ["owner"] : []);
  const detail = useOperation<LegacyArchiveDetail>(
    `/legacy-history/${encodeURIComponent(selectedId)}`,
    allowed && selectedId ? ["owner"] : [],
  );
  const data = detail.isError ? undefined : detail.data;
  if (!allowed)
    return (
      <section className="rounded-lg border p-6">
        <h1 className="text-xl font-semibold">History archive</h1>
        <p className="mt-2">
          Exit role preview and use an owner account to access private
          historical records.
        </p>
      </section>
    );
  function refresh() {
    void records.refetch();
    if (selectedId) void detail.refetch();
  }
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">History archive</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Privately retain historical records, original files and their
            reviewed source history.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={refresh}>
            Refresh archive
          </Button>
          <Button onClick={() => setImporting(true)}>Import history</Button>
        </div>
      </header>
      <section
        aria-label="Read-only historical archive"
        className="space-y-1 rounded-lg border bg-muted/30 p-4"
      >
        <h2 className="font-semibold">Historical archive only</h2>
        <p className="text-sm">
          These records never create active jobs, quotes, invoices, payments,
          stock movements or accounting balances. Source names and references
          are historical text, not links to live customers or vendors. Original
          files are private downloads only.
        </p>
      </section>
      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          controls.update({
            q: search.trim() || null,
            type: typeInput || null,
            sourceSystem: sourceInput.trim() || null,
            page: null,
            record: null,
          });
        }}
      >
        <label className="min-w-44 flex-1 space-y-1 text-sm">
          Search history
          <Input
            maxLength={80}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Source ID, title, reference or party"
          />
        </label>
        <label className="space-y-1 text-sm">
          Historical type
          <select
            className="block h-10 rounded border bg-background px-3"
            value={typeInput}
            onChange={(event) => setTypeInput(event.target.value)}
          >
            <option value="">All types</option>
            {legacyArchiveTypes.map((type) => (
              <option key={type} value={type}>
                {legacyArchiveLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Source system
          <Input
            maxLength={80}
            value={sourceInput}
            onChange={(event) => setSourceInput(event.target.value)}
          />
        </label>
        <Button type="submit" variant="outline">
          Apply filters
        </Button>
      </form>
      <div className="grid gap-5 xl:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
        <section aria-label="Archived records" className="space-y-3">
          {records.isLoading && (
            <p role="status">Loading private historical records…</p>
          )}
          {records.isError && (
            <p role="alert">
              Historical records could not load.{" "}
              <button
                className="underline"
                onClick={() => void records.refetch()}
              >
                Retry archive
              </button>
            </p>
          )}
          {!records.isError && records.data && !records.data.records.length && (
            <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              No archived records match. Import a reviewed historical export
              when one is available.
            </p>
          )}
          {!records.isError && (
            <ul className="divide-y rounded-lg border">
              {records.data?.records.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    aria-pressed={selectedId === record.id}
                    className="w-full space-y-1 p-4 text-left text-sm hover:bg-muted/40 aria-pressed:bg-muted"
                    onClick={() => controls.update({ record: record.id })}
                  >
                    <span className="block break-words font-semibold">
                      {record.title}
                    </span>
                    <span className="block">
                      {legacyArchiveLabel(record.recordType)} ·{" "}
                      {record.sourceSystem} · ID {record.sourceId}
                    </span>
                    <span className="block text-muted-foreground">
                      Historical date: {record.occurredOn ?? "Unknown"} · Source
                      status: {record.status || "Not recorded"}
                    </span>
                    <span className="block break-words text-muted-foreground">
                      {record.partyName || "Source party not recorded"}
                      {record.reference ? ` · ${record.reference}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <nav
            aria-label="Archive pages"
            className="flex items-center justify-between gap-2"
          >
            <Button
              variant="outline"
              disabled={!page || records.isLoading}
              onClick={() =>
                controls.update({
                  page: page > 1 ? String(page - 1) : null,
                  record: null,
                })
              }
            >
              Previous page
            </Button>
            <span className="text-sm">Page {page + 1}</span>
            <Button
              variant="outline"
              disabled={
                records.isLoading || !records.data?.hasMore || page >= 1000
              }
              onClick={() =>
                controls.update({ page: String(page + 1), record: null })
              }
            >
              Next page
            </Button>
          </nav>
        </section>
        <section
          aria-label="Historical record detail"
          className="min-w-0 space-y-4"
        >
          {!selectedId && (
            <p className="rounded border border-dashed p-6 text-sm text-muted-foreground">
              Select a historical record to view its source, approval and
              private original files.
            </p>
          )}
          {selectedId && detail.isLoading && (
            <p role="status">Loading historical evidence…</p>
          )}
          {selectedId && detail.isError && (
            <p role="alert">
              This historical record could not load or is no longer accessible.{" "}
              <button
                className="underline"
                onClick={() => void detail.refetch()}
              >
                Recheck archive record
              </button>
            </p>
          )}
          {selectedId && data && (
            <>
              <header className="space-y-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="text-xl font-semibold">{data.record.title}</h2>
                  <Badge variant="outline">
                    Historical {legacyArchiveLabel(data.record.recordType)}
                  </Badge>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Source ID</dt>
                    <dd className="break-all">{data.record.sourceId}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Source reference</dt>
                    <dd className="break-words">
                      {data.record.reference || "Not recorded"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Source party</dt>
                    <dd className="break-words">
                      {data.record.partyName || "Not recorded"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Historical date</dt>
                    <dd>{data.record.occurredOn ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Source status</dt>
                    <dd>{data.record.status || "Not recorded"}</dd>
                  </div>
                </dl>
                {data.record.summary && (
                  <div className="space-y-1 text-sm">
                    <h3 className="font-medium">Source summary</h3>
                    <p className="whitespace-pre-wrap break-words">
                      {data.record.summary}
                    </p>
                  </div>
                )}
                <p className="break-all text-xs text-muted-foreground">
                  Record SHA-256: {data.record.recordSha256}
                </p>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={`/api/legacy-history/${encodeURIComponent(data.record.id)}/export`}
                    download
                  >
                    Download record and provenance JSON
                  </a>
                </Button>
              </header>
              <section
                aria-label="Archive source and approval"
                className="space-y-2 rounded-lg border p-4 text-sm"
              >
                <h2 className="font-semibold">Source and immutable approval</h2>
                <p>
                  {data.batch.sourceSystem} · Batch {data.batch.batchKey} ·
                  Source line {data.record.sourceLine}
                </p>
                <p className="break-words">
                  Original file: {data.batch.fileName}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  Source SHA-256: {data.batch.sourceSha256}
                </p>
                <p className="break-all">
                  Approved by account {data.approval.approvedBy} ·{" "}
                  {new Date(data.approval.approvedAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  {data.approval.reviewNote}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  Approval SHA-256: {data.approval.fingerprint}
                </p>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={`/api/legacy-history/imports/${encodeURIComponent(data.batch.id)}/source`}
                    download
                  >
                    Download original source CSV
                  </a>
                </Button>
              </section>
              <LegacyArchiveFiles
                key={data.record.id}
                recordId={data.record.id}
                documents={data.documents}
                onSaved={() => void detail.refetch()}
              />
            </>
          )}
        </section>
      </div>
      {importing && (
        <LegacyArchiveImport
          onClose={() => setImporting(false)}
          onCommitted={refresh}
        />
      )}
    </div>
  );
}
