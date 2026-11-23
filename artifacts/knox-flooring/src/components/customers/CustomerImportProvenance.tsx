import { useOperation } from "@/lib/operations";
interface Provenance {
  effectiveCustomerId: string;
  hasMore: boolean;
  records: {
    id: string;
    sourceSystem: string;
    sourceId: string;
    batchId: string;
    batchKey: string;
    fileName: string;
    sourceSha256: string;
    originalCustomerId: string;
    sourceLine: number;
    action: string;
  }[];
}
export function CustomerImportProvenance({
  customerId,
}: {
  customerId: string;
}) {
  const query = useOperation<Provenance>(
    `/customer-imports/provenance/${encodeURIComponent(customerId)}`,
    ["owner"],
  );
  if (!query.allowed) return null;
  if (query.isError)
    return (
      <p className="text-sm text-destructive">
        Import provenance could not load. Refresh before relying on this
        history.
      </p>
    );
  if (!query.data?.records.length) return null;
  const data = query.data;
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="font-semibold">Customer import history</h2>
      {data.records.map((record) => (
        <div key={record.id} className="text-sm">
          <p>
            {record.sourceSystem} · Source ID {record.sourceId} ·{" "}
            {record.action === "create" ? "Created" : "Explicitly linked"}
          </p>
          <p>
            {record.fileName} · Batch {record.batchKey} · Source line{" "}
            {record.sourceLine}
          </p>
          {record.originalCustomerId !== data.effectiveCustomerId && (
            <p>
              Retained original customer {record.originalCustomerId}; merged
              into current customer {data.effectiveCustomerId}.
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">
            Source SHA-256: {record.sourceSha256}
          </p>
        </div>
      ))}
      {data.hasMore && (
        <p className="text-sm">
          Showing the latest 200 source links. Earlier provenance remains in the
          saved source batches.
        </p>
      )}
    </section>
  );
}
