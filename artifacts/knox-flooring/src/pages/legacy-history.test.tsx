import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveDetail, archiveRecord } from "@/test/legacy-history-fixtures";
import LegacyHistory from "./legacy-history";
const state = vi.hoisted(() => ({
  user: { role: "owner", previewRole: null } as any,
  update: vi.fn(),
  refetch: vi.fn(),
  operation: vi.fn(),
  queries: [] as string[],
  detail: null as any,
  error: false,
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/hooks/use-url-state", () => ({
  useUrlState: (key: string, fallback: string) => [
    key === "record" ? "archive-a" : fallback,
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
      allowed,
      data: allowed
        ? path.includes("?")
          ? { records: [archiveRecord], hasMore: true, page: 0 }
          : state.detail
        : undefined,
      refetch: state.refetch,
      isError: !path.includes("?") && state.error,
    };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.user = { role: "owner", previewRole: null };
  state.queries = [];
  state.detail = structuredClone(archiveDetail);
  state.error = false;
});
afterEach(cleanup);

it("shows raw historical evidence and private provenance downloads without active links or automatic writes", () => {
  state.detail.record.summary =
    '<img src="https://elsewhere.invalid/x"><script>doNotRun()</script> Source amount $123.45';
  render(<LegacyHistory />);
  expect(
    screen.getByRole("heading", { name: "Historical archive only" }),
  ).toBeVisible();
  expect(screen.getByText(state.detail.record.summary)).toBeVisible();
  expect(document.querySelector("img,iframe,script")).toBeNull();
  expect(
    screen.getByRole("link", { name: "Download record and provenance JSON" }),
  ).toHaveAttribute("href", "/api/legacy-history/archive-a/export");
  expect(
    screen.getByRole("link", { name: "Download original source CSV" }),
  ).toHaveAttribute("href", "/api/legacy-history/imports/batch-a/source");
  for (const anchor of screen.getAllByRole("link")) {
    expect(anchor.getAttribute("href")).toMatch(/^\/api\/legacy-history\//);
    expect(anchor).toHaveAttribute("download");
  }
  expect(screen.getByText("00001", { exact: true })).toBeVisible();
  expect(screen.getByText("Unknown", { exact: true })).toBeVisible();
  expect(state.operation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh archive" }));
  expect(state.refetch).toHaveBeenCalledTimes(2);
  expect(state.operation).not.toHaveBeenCalled();
});
it("keeps filters and page selection inside the archive and clears stale detail selection", () => {
  render(<LegacyHistory />);
  fireEvent.change(screen.getByLabelText("Search history"), {
    target: { value: "00001" },
  });
  fireEvent.change(screen.getByLabelText("Historical type"), {
    target: { value: "invoice" },
  });
  fireEvent.change(screen.getByLabelText("Source system"), {
    target: { value: "legacy-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  expect(state.update).toHaveBeenCalledWith({
    q: "00001",
    type: "invoice",
    sourceSystem: "legacy-test",
    page: null,
    record: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(state.update).toHaveBeenLastCalledWith({ page: "1", record: null });
  expect(state.operation).not.toHaveBeenCalled();
});
it("hides stale detail and downloads when the private record fails to reload", () => {
  state.error = true;
  render(<LegacyHistory />);
  expect(screen.getByRole("alert")).toHaveTextContent("no longer accessible");
  expect(
    screen.queryByRole("link", { name: "Download record and provenance JSON" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Historical original files"),
  ).not.toBeInTheDocument();
});
it.each(["sales", "operations", "installer", "owner-preview"])(
  "blocks archive queries and downloads for %s",
  (role) => {
    state.user =
      role === "owner-preview"
        ? { role: "owner", previewRole: "owner" }
        : { role, previewRole: null };
    render(<LegacyHistory />);
    expect(
      screen.getByText(/Exit role preview and use an owner account/),
    ).toBeVisible();
    expect(state.queries).toEqual([]);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(state.operation).not.toHaveBeenCalled();
  },
);
