import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Suppliers from "./suppliers";
import {
  supplierContact,
  supplierBatch,
} from "@/test/supplier-contact-fixtures";
const state = vi.hoisted(() => ({
  user: { role: "owner", previewRole: null } as any,
  queries: [] as string[],
  operation: vi.fn(),
  update: vi.fn(),
  refetch: vi.fn(),
  detail: null as any,
  error: false,
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: (key: string, fallback: string) => [
    key === "supplier" ? "00000000-0000-4000-8000-000000000001" : fallback,
    vi.fn(),
  ],
  useQueryControls: () => ({ update: state.update }),
}));
vi.mock("@/lib/operations", () => ({
  operation: state.operation,
  useOperation: (path: string, roles: string[]) => {
    const allowed = !!state.user && roles.includes(state.user.role);
    if (allowed) state.queries.push(path);
    return {
      data: allowed
        ? path.includes("?")
          ? { suppliers: [supplierContact], page: 0, hasMore: true }
          : state.detail
        : undefined,
      isError: state.error && !path.includes("?"),
      refetch: state.refetch,
    };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.user = { role: "owner", previewRole: null };
  state.queries = [];
  state.error = false;
  state.detail = {
    supplier: structuredClone(supplierContact),
    provenance: [
      {
        record: {
          id: "record",
          sourceId: "000081",
          sourceSystem: "legacy-test",
          sourceLine: 2,
          action: "link",
          sourceData: {
            name: "<script>doNotRun()</script> Original source name",
          },
          supplierSnapshot: { name: "Original Supply", phone: "000099" },
        },
        batch: {
          id: supplierBatch.id,
          fileName: "Original.csv",
          sourceSha256: "a".repeat(64),
        },
        approval: {
          reviewNote: "Owner verified source contact",
          approvedAt: "2026-11-23",
        },
      },
    ],
  };
});
afterEach(cleanup);
it.each([
  null,
  { role: "operations" },
  { role: "sales" },
  { role: "installer" },
  { role: "owner", previewRole: "sales" },
])(
  "does not query or expose directory contacts outside actual-owner mode %j",
  (user) => {
    state.user = user;
    render(<Suppliers />);
    expect(state.queries).toEqual([]);
    expect(screen.queryByRole("button", { name: "Add supplier" })).toBeNull();
    expect(state.operation).not.toHaveBeenCalled();
  },
);
it("shows contacts and immutable source provenance as plain text with private source attachment only", () => {
  render(<Suppliers />);
  expect(
    screen.getByText(
      "Original source name: <script>doNotRun()</script> Original source name",
    ),
  ).toBeVisible();
  expect(document.querySelector("script,img,iframe")).toBeNull();
  expect(
    screen.getByRole("link", { name: "Download original supplier source" }),
  ).toHaveAttribute("href", `/api/supplier-imports/${supplierBatch.id}/source`);
  expect(state.operation).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /merge|delete/i })).toBeNull();
});
it("keeps filtering and paging in URL state and refresh performs reads only", () => {
  render(<Suppliers />);
  fireEvent.change(screen.getByLabelText("Search suppliers"), {
    target: { value: "Specific supplier" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search directory" }));
  expect(state.update).toHaveBeenCalledWith({
    q: "Specific supplier",
    page: null,
    supplier: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Next suppliers" }));
  expect(state.update).toHaveBeenCalledWith({ page: "1", supplier: null });
  fireEvent.click(screen.getByRole("button", { name: "Refresh suppliers" }));
  expect(state.refetch).toHaveBeenCalledTimes(2);
  expect(state.operation).not.toHaveBeenCalled();
});
it("hides stale supplier detail and edit controls after a failed detail read", () => {
  state.error = true;
  render(<Suppliers />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Supplier details could not load",
  );
  expect(screen.queryByRole("button", { name: "Edit contacts" })).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Download original supplier source" }),
  ).toBeNull();
});
