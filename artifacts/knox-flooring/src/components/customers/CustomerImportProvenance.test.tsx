import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CustomerImportProvenance } from "./CustomerImportProvenance";
const { useOperation } = vi.hoisted(() => ({ useOperation: vi.fn() }));
vi.mock("@/lib/operations", () => ({ useOperation }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("shows original and retained identities after a merge without changing source history", () => {
  useOperation.mockReturnValue({
    allowed: true,
    data: {
      effectiveCustomerId: "retained",
      hasMore: true,
      records: [
        {
          id: "source-record",
          sourceSystem: "fictional-legacy",
          sourceId: "00001",
          batchId: "batch",
          batchKey: "fictional-batch",
          fileName: "Fictional.csv",
          sourceSha256: "a".repeat(64),
          originalCustomerId: "original",
          sourceLine: 2,
          action: "create",
        },
      ],
    },
  });
  render(<CustomerImportProvenance customerId="retained" />);
  expect(useOperation).toHaveBeenCalledWith(
    "/customer-imports/provenance/retained",
    ["owner"],
  );
  expect(screen.getByText(/Source ID 00001/)).toBeVisible();
  expect(screen.getByText(/Retained original customer original/)).toBeVisible();
  expect(screen.getByText(/latest 200 source links/)).toBeVisible();
});
it("does not display owner import history to unauthorized users", () => {
  useOperation.mockReturnValue({ allowed: false });
  render(<CustomerImportProvenance customerId="retained" />);
  expect(screen.queryByText("Customer import history")).not.toBeInTheDocument();
});
