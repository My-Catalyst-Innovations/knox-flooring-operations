import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  openPoImportColumns,
  openPoImportMaxBytes,
  openPoSnapshotTimes,
  validateOpenPoChoices,
  type OpenPoDecision,
  type OpenPoExistingOrder,
  type OpenPoImportBatch,
  type OpenPoJob,
  type OpenPoLineDecision,
  type OpenPoProduct,
  type OpenPoSupplier,
  type OpenPoWarehouse,
} from "@workspace/domain";
import { useAuth } from "@/contexts/auth";
import { operation, useOperation } from "@/lib/operations";
import { useUrlState } from "@/hooks/use-url-state";
import { OpenPoImportLookup } from "@/components/inventory/OpenPoImportLookup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
type Draft = Omit<Partial<OpenPoDecision>, "lines"> & {
  lines: Record<number, Partial<OpenPoLineDecision>>;
};
type Selected = {
  supplier?: OpenPoSupplier;
  warehouse?: OpenPoWarehouse;
  job?: OpenPoJob;
  order?: OpenPoExistingOrder;
  products: Record<number, OpenPoProduct>;
};
type Summary = {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  status: string;
};
const initialFile = "Pasted outstanding orders.csv";
export default function OpenPoImports() {
  const { user } = useAuth(),
    allowed =
      user?.role === "owner" &&
      (user.actualRole ?? user.role) === "owner" &&
      !user.previewRole;
  const [selectedId, setSelectedId] = useUrlState<string>("batch", "");
  const history = useOperation<Summary[]>(
    "/open-po-imports",
    allowed ? ["owner"] : [],
  );
  const saved = useOperation<OpenPoImportBatch>(
    `/open-po-imports/${encodeURIComponent(selectedId)}`,
    allowed && selectedId ? ["owner"] : [],
  );
  const [batch, setBatch] = useState<OpenPoImportBatch | null>(null),
    [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [selections, setSelections] = useState<Record<string, Selected>>({});
  const [csv, setCsv] = useState(""),
    [fileName, setFileName] = useState(initialFile),
    [delimiter, setDelimiter] = useState<"," | "\t">(","),
    [sourceSystem, setSourceSystem] = useState(""),
    [batchKey, setBatchKey] = useState(""),
    [snapshotAt, setSnapshotAt] = useState(""),
    [cutoverAt, setCutoverAt] = useState("");
  const [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  const draftFor = (id: string): Draft =>
    Object.hasOwn(drafts, id) ? drafts[id] : { lines: {} };
  const current = batch?.id === selectedId ? batch : null;
  function load(value: OpenPoImportBatch) {
    setBatch(value);
    setConfirmed(false);
    setDirty(false);
    setNote(value.reviewNote ?? "");
    setDrafts(
      Object.fromEntries(
        value.reviewed.map((item) => [
          item.decision.sourcePoId,
          {
            ...item.decision,
            lines: Object.fromEntries(
              (item.decision.lines ?? []).map((line) => [line.line, line]),
            ),
          },
        ]),
      ),
    );
    setSelections(
      Object.fromEntries(
        value.reviewed.map((item) => [
          item.decision.sourcePoId,
          {
            supplier: item.selected?.supplier,
            warehouse: item.selected?.warehouse,
            job: item.selected?.job ?? undefined,
            order: item.selected?.existingOrder ?? undefined,
            products: Object.fromEntries(
              (item.selected?.lines ?? []).map((line) => [
                line.source.line,
                line.product,
              ]),
            ),
          },
        ]),
      ),
    );
  }
  useEffect(() => {
    if (
      allowed &&
      saved.data &&
      saved.data.id === selectedId &&
      saved.data.id !== batch?.id
    )
      load(saved.data);
  }, [saved.data, selectedId, allowed, batch?.id]);
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
          : "The import action was not confirmed. Reload the saved batch before retrying.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function update(id: string, change: Partial<OpenPoDecision>) {
    setDrafts((old) => {
      const previous = Object.hasOwn(old, id) ? old[id] : undefined;
      return {
        ...old,
        [id]: {
          ...previous,
          lines: previous?.lines ?? {},
          ...change,
          sourcePoId: id,
        } as Draft,
      };
    });
    setConfirmed(false);
    setDirty(true);
  }
  function lineUpdate(
    id: string,
    line: number,
    change: Partial<OpenPoLineDecision>,
  ) {
    setDrafts((old) => {
      const previous = Object.hasOwn(old, id) ? old[id] : undefined;
      return {
        ...old,
        [id]: {
          ...previous,
          sourcePoId: id,
          lines: {
            ...previous?.lines,
            [line]: { ...previous?.lines[line], ...change, line },
          },
        },
      };
    });
    setConfirmed(false);
    setDirty(true);
  }
  function selection(id: string, change: Partial<Selected>) {
    setSelections((old) => {
      const previous = Object.hasOwn(old, id) ? old[id] : undefined;
      return {
        ...old,
        [id]: { ...previous, products: previous?.products ?? {}, ...change },
      };
    });
  }
  const decisions =
    current?.rows.map(
      (row) =>
        ({
          ...draftFor(row.sourcePoId),
          sourcePoId: row.sourcePoId,
          lines: row.lines.map((line) => ({
            ...draftFor(row.sourcePoId).lines[line.line],
            line: line.line,
          })),
        }) as OpenPoDecision,
    ) ?? [];
  let reviewable = !!current && note.trim().length >= 10;
  if (current)
    try {
      for (const row of current.rows) {
        const decision = decisions.find(
          (item) => item.sourcePoId === row.sourcePoId,
        )!;
        if (
          !decision.action ||
          !decision.note ||
          decision.note.trim().length < 5
        )
          throw new Error();
        validateOpenPoChoices(row, decision);
        if (decision.action !== "skip" && !decision.warehouseUpdatedAt)
          throw new Error();
      }
    } catch {
      reviewable = false;
    }
  const frozen =
    !!current && ["approved", "committed"].includes(current.status);
  function act(name: "refresh" | "approve" | "commit", body: unknown) {
    if (!current) return;
    void run(async () => {
      load(
        await operation<OpenPoImportBatch>(
          `/open-po-imports/${current.id}/${name}`,
          "POST",
          body,
        ),
      );
      void history.refetch();
    });
  }
  if (!allowed)
    return (
      <p>
        Outstanding purchase-order imports require an owner outside role
        preview.
      </p>
    );
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">
          Import outstanding purchase orders
        </h1>
        <p className="text-sm">
          Carry forward only quantities still due from suppliers. This does not
          place an order, receive stock, import historical receipts, create
          bills or balances, change prices, or send messages.
        </p>
        <Link className="text-sm underline" href="/inventory/purchase-orders">
          Back to purchase orders
        </Link>
      </header>
      {error && (
        <p role="alert" className="rounded border p-3 text-sm">
          {error} Reload the saved batch to check an interrupted action before
          trying again.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="space-y-1 text-sm">
          Saved import
          <select
            className="ml-2 rounded border p-2"
            aria-label="Saved import"
            disabled={busy}
            value={selectedId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setConfirmed(false);
              setError("");
            }}
          >
            <option value="">New source snapshot</option>
            {(history.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.sourceSystem} / {item.batchKey} · {item.status}
              </option>
            ))}
          </select>
        </label>
        {selectedId && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                load(
                  await operation<OpenPoImportBatch>(
                    `/open-po-imports/${selectedId}`,
                  ),
                ),
              )
            }
          >
            Reload saved batch
          </Button>
        )}
      </div>
      {selectedId && !current && (
        <p role={saved.isError ? "alert" : "status"}>
          {saved.isError
            ? "This saved import could not be loaded."
            : "Loading source snapshot…"}
        </p>
      )}
      {!selectedId && (
        <section
          className="space-y-4 rounded border p-4"
          aria-label="New source snapshot"
        >
          <p className="text-sm">
            Use the fixed version 1 template: 1–200 source lines, up to 100
            lines per PO, UTF-8 CSV/TSV up to 200 KB. IDs stay text; quantities
            and unit costs allow six decimals. Only USD and exact stock units
            are supported.
          </p>
          <a
            href="/api/open-po-imports/template"
            download
            className="text-sm underline"
          >
            Download header-only template
          </a>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">
              Source system ID
              <Input
                value={sourceSystem}
                disabled={busy}
                maxLength={80}
                onChange={(e) => setSourceSystem(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              Source batch ID
              <Input
                value={batchKey}
                disabled={busy}
                maxLength={120}
                onChange={(e) => setBatchKey(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              Source file label
              <Input
                value={fileName}
                disabled={busy}
                maxLength={200}
                onChange={(e) => setFileName(e.target.value)}
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              Source snapshot timestamp
              <Input
                value={snapshotAt}
                disabled={busy}
                placeholder="YYYY-MM-DDTHH:mm:ss-05:00"
                onChange={(e) => setSnapshotAt(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm">
              Cutover timestamp
              <Input
                value={cutoverAt}
                disabled={busy}
                placeholder="YYYY-MM-DDTHH:mm:ss-05:00"
                onChange={(e) => setCutoverAt(e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Enter the actual timestamps with their time zones. Snapshot must be
            no later than cutover, and neither may be in the future. They are
            source evidence; they do not schedule anything.
          </p>
          <label className="block text-sm">
            Choose outstanding PO CSV or TSV
            <input
              className="ml-2"
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
                  if (!file.size || file.size > openPoImportMaxBytes)
                    throw new Error("Choose a source file up to 200 KB.");
                  let text: string;
                  try {
                    text = new TextDecoder("utf-8", {
                      fatal: true,
                      ignoreBOM: true,
                    }).decode(await file.arrayBuffer());
                  } catch {
                    throw new Error(
                      "Export the source file as valid UTF-8 CSV or TSV.",
                    );
                  }
                  setCsv(text);
                  setFileName(file.name);
                  setDelimiter(
                    file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
                  );
                });
              }}
            />
          </label>
          <label className="block space-y-1 text-sm">
            Paste source CSV or TSV
            <Textarea
              rows={8}
              value={csv}
              disabled={busy}
              placeholder={openPoImportColumns.join(",")}
              onChange={(e) => {
                setCsv(e.target.value);
                setError("");
              }}
            />
          </label>
          <label className="text-sm">
            Separator
            <select
              className="ml-2 rounded border p-2"
              aria-label="Separator"
              disabled={busy}
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value as "," | "\t")}
            >
              <option value=",">Comma</option>
              <option value={"\t"}>Tab</option>
            </select>
          </label>
          <Button
            type="button"
            disabled={
              busy ||
              !csv.trim() ||
              !fileName.trim() ||
              !batchKey.trim() ||
              !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(sourceSystem) ||
              !openPoSnapshotTimes(snapshotAt, cutoverAt)
            }
            onClick={() =>
              void run(async () => {
                if (new Blob([csv]).size > openPoImportMaxBytes)
                  throw new Error("Use source data up to 200 KB.");
                const result = await operation<OpenPoImportBatch>(
                  "/open-po-imports/preview",
                  "POST",
                  {
                    sourceSystem,
                    batchKey: batchKey.trim(),
                    fileName: fileName.trim(),
                    csv,
                    delimiter,
                    sourceSnapshotAt: snapshotAt,
                    cutoverAt,
                  },
                );
                load(result);
                setSelectedId(result.id);
                void history.refetch();
              })
            }
          >
            {busy ? "Reading source…" : "Save source preview"}
          </Button>
        </section>
      )}
      {current && (
        <>
          <section className="space-y-2 rounded border p-4 text-sm">
            <h2 className="font-semibold">
              {current.sourceSystem} / {current.batchKey} · {current.status}
            </h2>
            <p>
              {current.fileName} · SHA-256 {current.sourceSha256}
            </p>
            <p>
              Source snapshot: {current.sourceSnapshotAt} · Cutover:{" "}
              {current.cutoverAt}
            </p>
            <a
              className="underline"
              href={`/api/open-po-imports/${current.id}/source`}
              download
            >
              Download original source bytes
            </a>
          </section>
          {current.rows.map((row) => {
            const id = row.sourcePoId,
              draft = draftFor(id),
              chosen = Object.hasOwn(selections, id)
                ? selections[id]
                : undefined,
              skip = draft.action === "skip";
            return (
              <section
                key={id}
                aria-label={`Source PO ${row.lines[0].sourcePoNumber}`}
                className="space-y-4 rounded border p-4"
              >
                <div>
                  <h2 className="text-lg font-semibold">
                    Source PO {row.lines[0].sourcePoNumber}
                  </h2>
                  <p className="text-sm">
                    Source ID {id} · Original status:{" "}
                    {row.lines[0].sourceStatus}
                  </p>
                  <p className="text-sm">
                    Source supplier: {row.lines[0].supplierRef} · Warehouse:{" "}
                    {row.lines[0].warehouseRef} · Job:{" "}
                    {row.lines[0].jobRef || "None recorded"}
                  </p>
                </div>
                {!!row.errors.length && (
                  <ul className="text-sm" role="alert">
                    {row.errors.map((message, i) => (
                      <li key={i}>{message}</li>
                    ))}
                  </ul>
                )}
                {row.imported && (
                  <p className="text-sm">
                    This source already has a Works order.{" "}
                    <Link
                      className="underline"
                      href={`/inventory/purchase-orders?order=${encodeURIComponent(row.imported.orderId)}`}
                    >
                      Open existing order
                    </Link>
                    . Explicitly skip this source; it will not be imported
                    twice.
                  </p>
                )}
                <div className="overflow-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Unchanged source quantities and costs
                    </caption>
                    <thead>
                      <tr>
                        {[
                          "Line ID / product reference",
                          "Unit",
                          "Originally ordered",
                          "Previously received",
                          "Previously cancelled",
                          "Outstanding",
                          "Source unit cost",
                        ].map((label) => (
                          <th className="p-2" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {row.lines.map((line) => (
                        <tr key={line.line} className="border-t">
                          <td className="p-2">
                            {line.sourceLineId} / {line.productRef}
                          </td>
                          <td>{line.unit}</td>
                          <td>{line.orderedQty}</td>
                          <td>{line.receivedQty}</td>
                          <td>{line.cancelledQty}</td>
                          <td>{line.outstandingQty}</td>
                          <td>
                            {line.unitCost || "Missing — blocked"}{" "}
                            {line.currency}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <fieldset disabled={busy || frozen} className="space-y-4">
                  <label className="block text-sm">
                    Order decision
                    <select
                      aria-label={`Decision for source PO ${id}`}
                      className="ml-2 rounded border p-2"
                      value={draft.action ?? ""}
                      onChange={(e) => {
                        const action = e.target
                          .value as OpenPoDecision["action"];
                        update(id, {
                          action,
                          ...(action !== "link"
                            ? {
                                orderId: undefined,
                                orderRevision: undefined,
                                orderFingerprint: undefined,
                              }
                            : {}),
                        });
                        if (action !== "link")
                          selection(id, { order: undefined });
                      }}
                    >
                      <option value="">Choose explicitly</option>
                      <option
                        value="create"
                        disabled={!!row.errors.length || !!row.imported}
                      >
                        Create remaining Ordered PO only
                      </option>
                      <option
                        value="link"
                        disabled={!!row.errors.length || !!row.imported}
                      >
                        Link matching existing open PO without changes
                      </option>
                      <option value="skip">Skip this source order</option>
                    </select>
                  </label>
                  <label className="block space-y-1 text-sm">
                    Order review note
                    <Textarea
                      aria-label={`Review note for source PO ${id}`}
                      maxLength={1000}
                      value={draft.note ?? ""}
                      onChange={(e) => update(id, { note: e.target.value })}
                    />
                  </label>
                  {draft.action && !skip && (
                    <>
                      <OpenPoImportLookup<OpenPoSupplier>
                        kind="supplier"
                        label={`supplier for ${id}`}
                        selected={chosen?.supplier}
                        describe={(item) => item.name}
                        disabled={busy || frozen}
                        onSelect={(item) => {
                          selection(id, { supplier: item });
                          update(id, {
                            supplierId: item.id,
                            supplierRevision: item.revision,
                          });
                        }}
                      />
                      <OpenPoImportLookup<OpenPoWarehouse>
                        kind="warehouse"
                        label={`warehouse for ${id}`}
                        selected={chosen?.warehouse}
                        describe={(item) => item.name}
                        disabled={busy || frozen}
                        onSelect={(item) => {
                          selection(id, { warehouse: item });
                          update(id, {
                            warehouseId: item.id,
                            warehouseUpdatedAt: item.updatedAt,
                          });
                        }}
                      />
                      <label className="block text-sm">
                        Job link
                        <select
                          aria-label={`Job link for ${id}`}
                          className="ml-2 rounded border p-2"
                          value={
                            draft.jobId === null
                              ? "none"
                              : draft.jobId
                                ? "linked"
                                : ""
                          }
                          onChange={(e) => {
                            if (e.target.value === "none") {
                              selection(id, { job: undefined });
                              update(id, {
                                jobId: null,
                                jobRevision: undefined,
                                jobUpdatedAt: undefined,
                              });
                            }
                          }}
                        >
                          <option value="">Choose explicitly</option>
                          <option value="none" disabled={!!row.lines[0].jobRef}>
                            No job link
                          </option>
                          <option value="linked" disabled>
                            Selected existing job
                          </option>
                        </select>
                      </label>
                      <OpenPoImportLookup<OpenPoJob>
                        kind="job"
                        label={`job for ${id}`}
                        selected={chosen?.job}
                        describe={(item) =>
                          `${item.jobNumber} · ${item.customerName}`
                        }
                        disabled={busy || frozen}
                        onSelect={(item) => {
                          selection(id, { job: item });
                          update(id, {
                            jobId: item.id,
                            jobRevision: item.revision,
                            jobUpdatedAt: item.updatedAt,
                          });
                        }}
                      />
                      {draft.action === "link" && (
                        <OpenPoImportLookup<OpenPoExistingOrder>
                          kind="order"
                          label={`existing open PO for ${id}`}
                          selected={chosen?.order}
                          describe={(item) =>
                            `${item.orderNumber} · ${item.supplier} · ${item.status}`
                          }
                          disabled={busy || frozen}
                          onSelect={(item) => {
                            selection(id, { order: item });
                            update(id, {
                              orderId: item.id,
                              orderRevision: item.revision,
                              orderFingerprint: item.fingerprint,
                            });
                          }}
                        />
                      )}
                      {draft.action === "link" && chosen?.order && (
                        <div className="space-y-2 rounded border p-3 text-sm">
                          <p>
                            Selected Works order:{" "}
                            <Link
                              className="underline"
                              href={`/inventory/purchase-orders?order=${encodeURIComponent(chosen.order.id)}`}
                            >
                              {chosen.order.orderNumber}
                            </Link>{" "}
                            · {chosen.order.status}. Linking will not change it.
                          </p>
                          <ul>
                            {chosen.order.lines.map((line) => (
                              <li key={line.id}>
                                {line.sku} · {line.productName} ·{" "}
                                {line.outstandingQty} {line.unit} outstanding ·
                                Works order unit cost {line.unitCost} USD ·{" "}
                                {line.receivedQty} already received in Works
                              </li>
                            ))}
                          </ul>
                          <p>
                            Receipt snapshot SHA-256:{" "}
                            {chosen.order.receiptFingerprint}
                          </p>
                        </div>
                      )}
                      {row.lines.map((line) => {
                        const choice = draft.lines[line.line] ?? {};
                        return (
                          <div
                            className="space-y-3 rounded border p-3"
                            key={line.line}
                          >
                            <label className="block text-sm">
                              Source line {line.sourceLineId}
                              <select
                                aria-label={`Decision for line ${line.line}`}
                                className="ml-2 rounded border p-2"
                                value={choice.action ?? ""}
                                onChange={(e) =>
                                  lineUpdate(id, line.line, {
                                    action: e.target
                                      .value as OpenPoLineDecision["action"],
                                  })
                                }
                              >
                                <option value="">Choose explicitly</option>
                                <option value="include">
                                  Include only outstanding {line.outstandingQty}{" "}
                                  {line.unit}
                                </option>
                                <option value="skip">
                                  Skip this source line
                                </option>
                              </select>
                            </label>
                            <label className="block space-y-1 text-sm">
                              Line review note
                              <Textarea
                                aria-label={`Review note for line ${line.line}`}
                                value={choice.note ?? ""}
                                maxLength={500}
                                onChange={(e) =>
                                  lineUpdate(id, line.line, {
                                    note: e.target.value,
                                  })
                                }
                              />
                            </label>
                            {choice.action === "include" && (
                              <>
                                <OpenPoImportLookup<OpenPoProduct>
                                  kind="product"
                                  label={`stock product for line ${line.line}`}
                                  selected={chosen?.products[line.line]}
                                  describe={(item) =>
                                    `${item.sku || "No SKU"} · ${item.name} · ${item.unit}`
                                  }
                                  disabled={busy || frozen}
                                  onSelect={(item) => {
                                    selection(id, {
                                      products: {
                                        ...chosen?.products,
                                        [line.line]: item,
                                      },
                                    });
                                    lineUpdate(id, line.line, {
                                      productId: item.id,
                                      productRevision: item.revision,
                                    });
                                  }}
                                />
                                <label className="block space-y-1 text-sm">
                                  Reason for a genuine zero source cost
                                  (required only when zero)
                                  <Input
                                    aria-label={`Zero cost reason for line ${line.line}`}
                                    value={choice.zeroCostReason ?? ""}
                                    maxLength={500}
                                    onChange={(e) =>
                                      lineUpdate(id, line.line, {
                                        zeroCostReason:
                                          e.target.value || undefined,
                                      })
                                    }
                                  />
                                </label>
                              </>
                            )}
                          </div>
                        );
                      })}
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.sourceOpenConfirmed ?? false}
                          onChange={(e) =>
                            update(id, {
                              sourceOpenConfirmed: e.target.checked,
                            })
                          }
                        />
                        I verified this source order is still open and these
                        exact outstanding quantities remain due at cutover,
                        including any activity since the snapshot.
                      </label>
                      <label className="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.outstandingOnlyConfirmed ?? false}
                          onChange={(e) =>
                            update(id, {
                              outstandingOnlyConfirmed: e.target.checked,
                            })
                          }
                        />
                        Carry forward only remaining quantities; retain earlier
                        receipts as source evidence without creating Works
                        receipts.
                      </label>
                    </>
                  )}
                </fieldset>
                {current.reviewed.find(
                  (item) => item.decision.sourcePoId === id,
                )?.selected && (
                  <p className="text-sm">
                    Saved mapping:{" "}
                    {
                      current.reviewed.find(
                        (item) => item.decision.sourcePoId === id,
                      )!.selected!.supplier.name
                    }{" "}
                    →{" "}
                    {
                      current.reviewed.find(
                        (item) => item.decision.sourcePoId === id,
                      )!.selected!.warehouse.name
                    }
                    .{" "}
                    {dirty
                      ? "Local changes need a new saved review."
                      : "This is the saved snapshot included in approval."}
                  </p>
                )}
              </section>
            );
          })}
          <section className="space-y-4 rounded border p-4">
            <label className="block space-y-1 text-sm">
              Batch review note
              <Textarea
                disabled={busy || frozen}
                value={note}
                maxLength={1000}
                onChange={(e) => {
                  setNote(e.target.value);
                  setConfirmed(false);
                  setDirty(true);
                }}
              />
            </label>
            {["preview", "reviewed"].includes(current.status) && (
              <Button
                type="button"
                disabled={busy || !reviewable}
                onClick={() =>
                  void run(async () => {
                    load(
                      await operation<OpenPoImportBatch>(
                        `/open-po-imports/${current.id}/review`,
                        "POST",
                        {
                          revision: current.revision,
                          previewFingerprint: current.previewFingerprint,
                          note: note.trim(),
                          decisions,
                        },
                      ),
                    );
                  })
                }
              >
                Save reviewed mappings
              </Button>
            )}
            {current.status === "reviewed" && (
              <>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    disabled={busy || dirty}
                  />
                  I reviewed the exact saved source and mappings. Create or link
                  outstanding-only POs; do not import receipts, stock, bills or
                  financial balances.
                </label>
                <Button
                  type="button"
                  disabled={busy || dirty || !confirmed}
                  onClick={() =>
                    act("approve", {
                      revision: current.revision,
                      reviewFingerprint: current.reviewFingerprint,
                      confirmOutstandingOnly: true,
                    })
                  }
                >
                  Approve saved outstanding-only review
                </Button>
              </>
            )}
            {current.status === "approved" && (
              <>
                <p className="text-sm">
                  Approval {current.approval?.id} is frozen. Changes to linked
                  records will block commit and require fresh review.
                </p>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    disabled={busy}
                  />
                  Commit this approved snapshot once, carrying only outstanding
                  quantities into Works.
                </label>
                <Button
                  type="button"
                  disabled={busy || !confirmed || !current.approval}
                  onClick={() =>
                    act("commit", {
                      revision: current.revision,
                      approvalId: current.approval!.id,
                      approvalFingerprint: current.approval!.fingerprint,
                      confirmOutstandingOnly: true,
                    })
                  }
                >
                  Commit approved remaining orders
                </Button>
              </>
            )}
            {current.status !== "committed" && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => act("refresh", { revision: current.revision })}
              >
                Refresh identities and discard current review
              </Button>
            )}
            {current.result && (
              <div role="status" className="space-y-2">
                <p>
                  {current.result.created} remaining orders created ·{" "}
                  {current.result.linked} existing orders linked without changes
                  · {current.result.skipped} source orders skipped. No stock or
                  earlier receipts were imported.
                </p>
                <ul>
                  {current.result.orders.map((item) => (
                    <li key={item.sourcePoId}>
                      Source PO {item.sourcePoNumber} →{" "}
                      <Link
                        className="underline"
                        href={`/inventory/purchase-orders?order=${encodeURIComponent(item.orderId)}`}
                      >
                        {item.orderNumber}
                      </Link>{" "}
                      · outstanding-only
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
