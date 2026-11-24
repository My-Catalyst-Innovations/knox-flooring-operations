import { useState } from "react";
import { useOperation } from "@/lib/operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function OpenPoImportLookup<T extends { id: string }>({
  kind,
  label,
  selected,
  describe,
  onSelect,
  disabled = false,
}: {
  kind: "supplier" | "warehouse" | "product" | "job" | "order";
  label: string;
  selected: T | undefined;
  describe: (item: T) => string;
  onSelect: (item: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [q, setQ] = useState(""),
    [page, setPage] = useState(0);
  const query = useOperation<{ items: T[]; hasMore: boolean; page: number }>(
    `/open-po-imports/options?${new URLSearchParams({ kind, q, page: String(page) })}`,
    open && !disabled ? ["owner"] : [],
  );
  return (
    <div className="space-y-2 text-sm">
      <p>
        {label}:{" "}
        <strong>{selected ? describe(selected) : "Not selected"}</strong>
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {open ? "Close selection" : `Choose ${label}`}
      </Button>
      {open && !disabled && (
        <div
          className="space-y-2 rounded border p-3"
          role="group"
          aria-label={`${label} selection`}
        >
          <Input
            aria-label={`Search ${label}`}
            value={q}
            maxLength={80}
            onChange={(event) => {
              setQ(event.target.value);
              setPage(0);
            }}
            placeholder="Search name, reference or ID"
          />
          {query.isFetching && <p role="status">Loading choices…</p>}
          {query.isError && (
            <p role="alert">
              Choices could not be loaded.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void query.refetch()}
              >
                Retry choices
              </button>
            </p>
          )}
          {!query.isError && !query.isFetching && query.data && (
            <>
              {!query.data.items.length && (
                <p>
                  No matching records. Create or correct the record in its
                  normal workflow first.
                </p>
              )}
              <ul className="max-h-60 space-y-1 overflow-auto">
                {query.data.items.map((item) => (
                  <li key={item.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto whitespace-normal text-left"
                      onClick={() => {
                        onSelect(item);
                        setOpen(false);
                      }}
                    >
                      {describe(item)}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Previous choices
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!query.data.hasMore}
                  onClick={() => setPage(page + 1)}
                >
                  More choices
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
