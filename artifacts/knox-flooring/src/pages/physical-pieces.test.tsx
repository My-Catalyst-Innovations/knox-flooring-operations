import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PhysicalPieces from "./physical-pieces";

const mocks = vi.hoisted(() => ({ operation: vi.fn(), refresh: vi.fn(), issued: false, bound: true, role: "owner" }));
const piece = {
  id: "piece-1", label: "CARPET-CUT-1", sku: "CARPET-1", productId: "product-1", productName: "Carpet",
  parentLabel: "ROLL-1", warehouseId: "warehouse-1", binId: "bin-1", widthInches: 120,
  lengthInches: 30, quantity: 25, kind: "Remnant", lot: "DYE-1", revision: 2,
};

vi.mock("@/hooks/use-store", () => ({
  useStore: () => ({
    products: [], jobs: [{ id: "job-1", jobNumber: "KNOX-100", customerName: "Customer", status: "Approved" }],
  }),
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock("@/lib/operations", async (original) => ({
  ...await original<typeof import("@/lib/operations")>(),
  operation: mocks.operation,
  useRefreshOperations: () => mocks.refresh,
  useOperation(path: string) {
    const stockData = {
      pieces: [{
        ...piece, issuedMovementId: mocks.issued ? "issue-1" : null, issuedJobId: mocks.issued ? "job-1" : null,
        costAllocations: mocks.bound ? [{ layerId: "receipt:0", sourceMovementId: "receipt", source: "stock_receipt", acquiredAt: "2026-11-23T12:00:00Z", quantity: 25, unitCost: "2.000000" }] : null,
      }],
      hasMore: false,
    };
    const data = path.endsWith("/cost-sources") ? { layers: [{ layerId: "actual-receipt:0", sourceMovementId: "actual-receipt", source: "stock_receipt", acquiredAt: "2026-11-23T12:00:00Z", quantity: 100, unitCost: "4.250000" }], unpricedQuantity: 0 }
      : path.startsWith("/inventory/reservations")
      ? [{ id: "reservation-1", status: "Active", warehouseId: "warehouse-1", jobId: "job-1", quantity: 25, revision: 1 }]
      : path === "/inventory/warehouses"
        ? [{ id: "warehouse-1", name: "Main warehouse" }, { id: "warehouse-2", name: "Second warehouse" }]
        : path === "/inventory/bins"
          ? [{ id: "bin-1", warehouseId: "warehouse-1", code: "A-1" }, { id: "bin-2", warehouseId: "warehouse-2", code: "B-1" }]
          : stockData;
    return { data, isLoading: false, isError: false };
  },
}));

beforeEach(() => {
  window.history.replaceState({}, "", "/inventory/physical-pieces");
  mocks.issued = false;
  mocks.bound = true; mocks.role = "owner";
  mocks.operation.mockReset().mockResolvedValue({});
  mocks.refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("labeled stock jobs", () => {
  it("requires owner acquisition review before an unbound piece can be cut, moved, or issued", async () => {
    mocks.bound = false;
    render(<PhysicalPieces />);
    for (const label of ["Cut a piece", "Move piece", "Issue to a job"]) expect(screen.getByRole("button", { name: label })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review cost" }));
    const form = within(screen.getByRole("dialog"));
    fireEvent.change(form.getByLabelText("Actual acquisition source"), { target: { value: "actual-receipt:0" } });
    fireEvent.change(form.getByLabelText("Review note"), { target: { value: "Matched physical tag to vendor invoice 14" } });
    fireEvent.click(form.getByRole("button", { name: "Confirm reviewed cost" }));
    await waitFor(() => expect(mocks.operation).toHaveBeenCalledWith("/inventory/physical-pieces/piece-1/bind-cost", "POST", expect.objectContaining({
      revision: 2, sourceLayerId: "actual-receipt:0", note: "Matched physical tag to vendor invoice 14", idempotencyKey: expect.any(String),
    })));
  });

  it("keeps unreviewed historical issues returnable without granting operations cost review", () => {
    mocks.bound = false; mocks.issued = true; mocks.role = "operations";
    render(<PhysicalPieces />);
    expect(screen.getByRole("button", { name: "Return from job" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Review cost" })).toBeNull();
  });

  it("uses the matching existing reservation when an operator issues a piece", async () => {
    render(<PhysicalPieces />);
    fireEvent.click(screen.getByRole("button", { name: "Issue to a job" }));
    const form = within(screen.getByRole("dialog"));
    fireEvent.change(form.getByLabelText("Job"), { target: { value: "job-1" } });
    expect((form.getByLabelText("Stock source") as HTMLSelectElement).value).toBe("reservation-1");
    fireEvent.click(form.getByRole("button", { name: "Issue to a job" }));
    await waitFor(() => expect(mocks.operation).toHaveBeenCalledWith("/inventory/reservations/reservation-1", "PATCH", {
      physicalPieceId: "piece-1", pieceRevision: 2, status: "Consumed", revision: 1, binId: "bin-1",
    }));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("asks for a fresh measurement and returns only the measured area to the original job", async () => {
    mocks.issued = true;
    render(<PhysicalPieces />);
    fireEvent.click(screen.getByRole("button", { name: "Return from job" }));
    const form = within(screen.getByRole("dialog"));
    const length = form.getByLabelText("Returned length (inches)") as HTMLInputElement;
    expect(length.value).toBe("");
    fireEvent.change(length, { target: { value: "12" } });
    fireEvent.click(form.getByRole("button", { name: "Return from job" }));
    await waitFor(() => expect(mocks.operation).toHaveBeenCalledWith("/inventory/movements", "POST", expect.objectContaining({
      kind: "return", physicalPieceId: "piece-1", pieceRevision: 2, productId: "product-1", jobId: "job-1",
      returnOfMovementId: "issue-1", returnLengthInches: 12, quantity: 10, binId: "bin-1",
    })));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("requires confirmation that a cross-warehouse move has already reached its destination", async () => {
    render(<PhysicalPieces />);
    fireEvent.click(screen.getByRole("button", { name: "Move piece" }));
    const form = within(screen.getByRole("dialog"));
    fireEvent.change(form.getByLabelText("Destination warehouse"), { target: { value: "warehouse-2" } });
    fireEvent.change(form.getByLabelText("Destination bin"), { target: { value: "bin-2" } });
    fireEvent.click(form.getByRole("button", { name: "Move piece" }));
    expect(mocks.operation).not.toHaveBeenCalled();
    fireEvent.click(form.getByRole("checkbox", { name: /already at the destination/ }));
    fireEvent.click(form.getByRole("button", { name: "Move piece" }));
    await waitFor(() => expect(mocks.operation).toHaveBeenCalledWith("/inventory/physical-pieces/piece-1/move", "POST", expect.objectContaining({
      destinationWarehouseId: "warehouse-2", binId: "bin-2", revision: 2, confirmedAtDestination: true,
    })));
  });

  it("prints a Code 128 symbol and the exact scoped piece label", () => {
    render(<PhysicalPieces />);
    const print = vi.fn();
    const printDocument = document.implementation.createHTMLDocument("Test print");
    const open = vi.spyOn(window, "open").mockReturnValue({ document: printDocument, focus: vi.fn(), print } as unknown as Window);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Print label" }));
      const preview = within(screen.getByRole("dialog", { name: "Stock label" }));
      expect(preview.getByText("CARPET-CUT-1")).toBeTruthy();
      expect(preview.getByText("CARPET-1")).toBeTruthy();
      expect(preview.getByText("piece-1")).toBeTruthy();
      expect(preview.getByText("120 × 30 in")).toBeTruthy();
      expect(preview.getByText("Main warehouse · A-1")).toBeTruthy();
      expect(preview.getByRole("img", { name: "Code 128 barcode for PIECE:CARPET-CUT-1" })).toBeVisible();
      expect(open).not.toHaveBeenCalled();
      fireEvent.click(preview.getByRole("button", { name: "Print" }));
      expect(print).toHaveBeenCalledOnce();
      expect(printDocument.querySelector("svg path")?.getAttribute("d")).toMatch(/^M12 0/);
      expect(printDocument.querySelector("svg")?.getAttribute("width")).toMatch(/mm$/);
      expect(printDocument.querySelector("code")?.textContent).toBe("PIECE:CARPET-CUT-1");
    } finally {
      open.mockRestore();
    }
  });
});
