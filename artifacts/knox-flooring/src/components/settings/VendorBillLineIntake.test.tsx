import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewBillIntake } from "@/lib/vendor-bill-intake";
import { VendorBillLineIntake } from "./VendorBillLineIntake";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/vendor-bill-document-reader", () => ({ readBillDocument: mocks.read }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function uploadDocument(onApply = vi.fn()) {
  render(<VendorBillLineIntake onApply={onApply} />);
  fireEvent.click(screen.getByText("Import bill lines"));
  fireEvent.change(screen.getByLabelText(/Invoice PDF or scan/), {
    target: { files: [new File(["pdf"], "invoice.pdf", { type: "application/pdf" })] },
  });
  return onApply;
}

describe("supplier PDF intake review", () => {
  it("requires an explicit line check before sending a scanned preview to the existing bill form", async () => {
    const preview = previewBillIntake("supplier_sku,unit,quantity,unit_cost\n00073,Box,2,49.925");
    mocks.read.mockResolvedValue({ preview, usedOcr: true, sources: [{ page: 2, row: 4 }] });
    const apply = uploadDocument();
    const button = await screen.findByRole("button", { name: "Use 1 line" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Page 2, row 4")).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /checked each scanned line/ }));
    fireEvent.click(button);
    expect(apply).toHaveBeenCalledWith([{ supplierSku: "00073", unit: "Box", quantity: "2", unitCost: "49.925" }]);
  });

  it("keeps an ambiguous document out of the bill and leaves CSV or manual entry available", async () => {
    mocks.read.mockRejectedValue(new Error("Page 1 does not have a readable table. Use CSV or manual entry."));
    const apply = uploadDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("does not have a readable table");
    expect(screen.queryByRole("button", { name: "Use 1 line" })).toBeNull();
    expect(screen.getByLabelText("Bill line CSV or text file")).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });
});
