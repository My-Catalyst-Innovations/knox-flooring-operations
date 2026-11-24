import { useState } from "react";
import { useAuth } from "@/contexts/auth";
import { useOperation } from "@/lib/operations";
import { useQueryControls, useUrlState } from "@/hooks/use-url-state";
import type { SupplierDetail, SupplierList } from "@/lib/supplier-contacts";
import {
  SupplierActivation,
  SupplierContactForm,
} from "@/components/suppliers/SupplierContactForm";
import { SupplierContactImport } from "@/components/suppliers/SupplierContactImport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Suppliers() {
  const { user } = useAuth(),
    allowed = user?.role === "owner" && !user.previewRole,
    controls = useQueryControls();
  const [q] = useUrlState<string>("q", ""),
    [active] = useUrlState<string>("active", "active"),
    [selectedId] = useUrlState<string>("supplier", ""),
    [pageValue] = useUrlState<string>("page", "0");
  const page =
    Number.isSafeInteger(Number(pageValue)) &&
    Number(pageValue) >= 0 &&
    Number(pageValue) <= 1000
      ? Number(pageValue)
      : 0;
  const [search, setSearch] = useState(q),
    [mode, setMode] = useState<"add" | "edit" | "activation" | "import" | null>(
      null,
    );
  const list = useOperation<SupplierList>(
    `/suppliers?q=${encodeURIComponent(q)}&active=${["active", "inactive", "all"].includes(active) ? active : "active"}&page=${page}`,
    allowed ? ["owner"] : [],
  );
  const detail = useOperation<SupplierDetail>(
    `/suppliers/${encodeURIComponent(selectedId)}`,
    allowed && selectedId ? ["owner"] : [],
  );
  const data = detail.isError ? undefined : detail.data;
  const refresh = () => {
    void list.refetch();
    if (selectedId) void detail.refetch();
  };
  if (!allowed)
    return (
      <section className="rounded border p-6">
        <h1>Supplier contacts</h1>
        <p>
          Exit role preview and use an owner account to manage supplier contacts
          and reviewed imports.
        </p>
      </section>
    );
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Supplier contacts</h1>
          <p>Maintain contacts and retain reviewed source identities.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={refresh}>
            Refresh suppliers
          </Button>
          <Button variant="outline" onClick={() => setMode("import")}>
            Import supplier contacts
          </Button>
          <Button onClick={() => setMode("add")}>Add supplier</Button>
        </div>
      </header>
      <p className="rounded border bg-muted/30 p-3 text-sm">
        This directory does not create supplier SKU aliases, prices, stock,
        purchase orders or accounting balances. Saving does not send messages.
        Canonical names and existing purchasing labels are retained; deactivate
        instead of deleting or merging.
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          controls.update({ q: search, page: null, supplier: null });
        }}
      >
        <label>
          Search suppliers
          <Input
            value={search}
            maxLength={80}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Status
          <select
            value={active}
            onChange={(event) =>
              controls.update({
                active: event.target.value,
                page: null,
                supplier: null,
              })
            }
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>
        </label>
        <Button type="submit" variant="outline">
          Search directory
        </Button>
      </form>
      <div className="grid gap-5 xl:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
        <section aria-label="Supplier directory" className="space-y-3">
          {list.isLoading && <p role="status">Loading suppliers…</p>}
          {list.isError && (
            <p role="alert">
              Suppliers could not load. Refresh before making a selection.
            </p>
          )}
          {!list.isError && list.data?.suppliers.length === 0 && (
            <p>
              No suppliers match. Add a supplier or import a reviewed contact
              export.
            </p>
          )}
          <ul className="divide-y rounded border">
            {!list.isError &&
              list.data?.suppliers.map((supplier) => (
                <li key={supplier.id}>
                  <button
                    type="button"
                    aria-pressed={selectedId === supplier.id}
                    className="w-full p-3 text-left"
                    onClick={() => controls.update({ supplier: supplier.id })}
                  >
                    <strong>{supplier.name}</strong>
                    <p>
                      {supplier.contactName ||
                        supplier.email ||
                        supplier.phone ||
                        "No contact recorded"}{" "}
                      · {supplier.active ? "Active" : "Inactive"}
                    </p>
                  </button>
                </li>
              ))}
          </ul>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={page === 0}
              onClick={() =>
                controls.update({ page: String(page - 1), supplier: null })
              }
            >
              Previous suppliers
            </Button>
            <Button
              variant="outline"
              disabled={!list.data?.hasMore || list.isError}
              onClick={() =>
                controls.update({ page: String(page + 1), supplier: null })
              }
            >
              Next suppliers
            </Button>
          </div>
        </section>
        <section aria-label="Supplier details" className="space-y-3">
          {!selectedId && (
            <p>
              Select a supplier to review its current contacts and retained
              source history.
            </p>
          )}
          {selectedId && detail.isLoading && (
            <p role="status">Loading supplier details…</p>
          )}
          {selectedId && detail.isError && (
            <p role="alert">
              Supplier details could not load. Refresh to verify the current
              company record.
            </p>
          )}
          {data && (
            <>
              <h2 className="text-xl font-semibold">{data.supplier.name}</h2>
              <p>
                {data.supplier.active ? "Active" : "Inactive"} · revision{" "}
                {data.supplier.revision}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setMode("edit")}>
                  Edit contacts
                </Button>
                <Button variant="outline" onClick={() => setMode("activation")}>
                  {data.supplier.active
                    ? "Deactivate supplier"
                    : "Reactivate supplier"}
                </Button>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded border p-3">
                {[
                  "contactName",
                  "email",
                  "phone",
                  "address",
                  "city",
                  "state",
                  "postalCode",
                  "country",
                  "notes",
                ].map((key) => (
                  <div key={key} className="contents">
                    <dt>{key}</dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {String(
                        data.supplier[key as keyof typeof data.supplier] ||
                          "Not recorded",
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <h3 className="font-semibold">Immutable import provenance</h3>
              {!data.provenance.length && (
                <p>
                  This supplier was added manually. No source import is linked.
                </p>
              )}
              {data.provenance.map((item) => (
                <article
                  key={item.record.id}
                  className="space-y-1 rounded border p-3 text-sm"
                >
                  <p>
                    {item.record.sourceSystem} · source ID{" "}
                    {item.record.sourceId} · line {item.record.sourceLine} ·{" "}
                    {item.record.action}
                  </p>
                  <p>Original source name: {item.record.sourceData.name}</p>
                  <p>Retained source file: {item.batch.fileName}</p>
                  <p className="break-all text-xs">
                    Source SHA-256: {item.batch.sourceSha256}
                  </p>
                  <p>
                    Owner review: {item.approval.reviewNote} ·{" "}
                    {item.approval.approvedAt}
                  </p>
                  <p>
                    Accepted source/contact snapshots remain unchanged after
                    ordinary contact corrections.
                  </p>
                  <details>
                    <summary>View accepted source and contact snapshot</summary>
                    <pre className="whitespace-pre-wrap break-words">
                      {JSON.stringify(
                        {
                          source: item.record.sourceData,
                          acceptedSupplier: item.record.supplierSnapshot,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                  <a
                    href={`/api/supplier-imports/${encodeURIComponent(item.batch.id)}/source`}
                    download
                    className="underline"
                  >
                    Download original supplier source
                  </a>
                </article>
              ))}
            </>
          )}
        </section>
      </div>
      {mode === "add" && (
        <SupplierContactForm
          onClose={() => setMode(null)}
          onSaved={(supplier) => {
            setMode(null);
            controls.update({ supplier: supplier.id, active: "all" });
            refresh();
          }}
        />
      )}
      {mode === "edit" && data && (
        <SupplierContactForm
          key={`${data.supplier.id}:${data.supplier.revision}`}
          supplier={data.supplier}
          onClose={() => setMode(null)}
          onSaved={() => {
            setMode(null);
            refresh();
          }}
        />
      )}
      {mode === "activation" && data && (
        <SupplierActivation
          supplier={data.supplier}
          onClose={() => setMode(null)}
          onSaved={() => {
            setMode(null);
            refresh();
          }}
        />
      )}
      {mode === "import" && (
        <SupplierContactImport
          onClose={() => setMode(null)}
          onCommitted={refresh}
        />
      )}
    </div>
  );
}
