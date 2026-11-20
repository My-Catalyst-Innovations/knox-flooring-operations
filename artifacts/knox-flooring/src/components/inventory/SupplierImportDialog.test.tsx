import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SupplierImportDialog } from "./SupplierImportDialog";
import { operation } from "@/lib/operations";

vi.mock("@/contexts/auth", () => ({
  useAuth: () => ({ user: { role: "owner" } }),
}));
vi.mock("@/lib/operations", () => ({
  useOperation: () => ({ data: [], isError: false, refetch: vi.fn() }),
  operation: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("previews supplier rows and saves only the mappings the owner can approve", async () => {
  vi.mocked(operation).mockResolvedValue({
    aliasesAdded: 2,
    pricesAdded: 2,
    alreadyApproved: 0,
  });
  render(
    <SupplierImportDialog
      disabled={false}
      products={[
        {
          id: "product-1",
          sku: "KF-001",
          supplier: "Sample Supply",
          unit: "Box",
          cost: 48,
          name: "Oak flooring",
          active: true,
        },
      ]}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Preview supplier CSV" }));
  const dialog = screen.getByRole("dialog");
  expect(
    within(dialog).getByRole("link", { name: "Download template" }),
  ).toHaveAttribute("download", "supplier-import-template.csv");
  const csv = [
    "supplier,supplier_sku,internal_sku,manufacturer_part_number,unit,unit_cost",
    "Sample Supply,00123,KF-001,M-0042,box,53.125",
    "Sample Supply,00456,KF-001,,box,48",
    "Sample Supply,00999,,,box,48",
  ].join("\r\n");
  const file = Object.assign(
    new File([csv], "suppliers.csv", { type: "text/csv" }),
    {
      text: async () => csv,
    },
  );
  fireEvent.change(within(dialog).getByLabelText("Supplier CSV"), {
    target: { files: [file] },
  });

  expect(
    await within(dialog).findByText("3 rows · 2 to review"),
  ).toHaveAttribute("role", "status");
  expect(within(dialog).getByText("Line 2 · 00123")).toBeVisible();
  expect(within(dialog).getByText("CSV 53.125 USD / box")).toBeVisible();
  expect(within(dialog).getByText("Higher buy cost")).toBeVisible();
  expect(within(dialog).getByText("No match")).toBeVisible();

  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "Needs review only" }),
  );
  const rows = within(dialog).getByRole("list", {
    name: "Supplier CSV preview",
  });
  expect(within(rows).getAllByRole("listitem")).toHaveLength(2);
  expect(within(rows).queryByText("Line 3 · 00456")).not.toBeInTheDocument();
  const approve = within(dialog).getByRole("button", {
    name: "Approve matched rows",
  });
  expect(approve).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText("Effective date"), {
    target: { value: "2026-11-20" },
  });
  fireEvent.change(within(dialog).getByLabelText("Price source"), {
    target: { value: "Approved vendor list" },
  });
  fireEvent.click(approve);
  expect(
    await within(dialog).findByText(
      "Saved 2 mappings and 2 prices. 0 rows were already approved.",
    ),
  ).toBeVisible();
  expect(operation).toHaveBeenCalledWith(
    "/inventory/supplier-crosswalk/approve",
    "POST",
    {
      effectiveOn: "2026-11-20",
      source: "Approved vendor list",
      rows: [
        {
          productId: "product-1",
          productSku: "KF-001",
          supplier: "Sample Supply",
          supplierSku: "00123",
          manufacturerPartNumber: "M-0042",
          unit: "box",
          unitCost: "53.125",
        },
        {
          productId: "product-1",
          productSku: "KF-001",
          supplier: "Sample Supply",
          supplierSku: "00456",
          manufacturerPartNumber: undefined,
          unit: "box",
          unitCost: "48",
        },
      ],
    },
  );
  vi.mocked(operation).mockResolvedValue({
    aliasesAdded: 1,
    pricesAdded: 1,
    alreadyApproved: 0,
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Choose catalog product" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Oak flooring · KF-001" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Approve matched rows" }),
  );
  expect(
    await within(dialog).findByText(
      "Saved 3 mappings and 3 prices. 0 rows were already approved.",
    ),
  ).toBeVisible();
  expect(operation).toHaveBeenLastCalledWith(
    "/inventory/supplier-crosswalk/approve",
    "POST",
    {
      effectiveOn: "2026-11-20",
      source: "Approved vendor list",
      rows: [
        {
          productId: "product-1",
          productSku: "KF-001",
          supplier: "Sample Supply",
          supplierSku: "00999",
          manufacturerPartNumber: undefined,
          unit: "box",
          unitCost: "48",
        },
      ],
    },
  );
});

it("lets the owner choose and approve a catalog SKU for an unmatched supplier code", async () => {
  vi.mocked(operation).mockResolvedValue({
    aliasesAdded: 1,
    pricesAdded: 1,
    alreadyApproved: 0,
  });
  const product = {
    id: "oak",
    name: "Oak flooring",
    sku: "KF-001",
    supplier: "Another supplier",
    unit: "Box",
    cost: 48,
    active: true,
  };
  render(
    <SupplierImportDialog
      disabled={false}
      products={[
        product,
        {
          ...product,
          id: "roll",
          sku: "KF-002",
          name: "Carpet roll",
          unit: "sqft",
        },
        {
          ...product,
          id: "old",
          sku: "KF-003",
          name: "Archived flooring",
          active: false,
        },
        {
          ...product,
          id: "duplicate-one",
          sku: "KF-004",
          name: "Duplicate flooring",
        },
        {
          ...product,
          id: "duplicate-two",
          sku: "kf-004",
          name: "Second duplicate",
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview supplier CSV" }));
  const dialog = within(screen.getByRole("dialog"));
  const csv =
    "supplier,supplier_sku,manufacturer_part_number,unit,unit_cost\nFixture Supply,00000,M-003,box,48";
  const file = Object.assign(
    new File([csv], "suppliers.csv", { type: "text/csv" }),
    { text: async () => csv },
  );
  fireEvent.change(dialog.getByLabelText("Supplier CSV"), {
    target: { files: [file] },
  });
  const choose = await dialog.findByRole("button", {
    name: "Choose catalog product",
  });
  expect(
    dialog.queryByRole("button", { name: "Approve matched rows" }),
  ).not.toBeInTheDocument();
  fireEvent.click(choose);
  const picker = within(
    dialog.getByRole("list", { name: "Catalog matches for 00000" }),
  );
  expect(picker.getAllByRole("button")).toHaveLength(1);
  fireEvent.change(
    dialog.getByRole("textbox", { name: "Search catalog for 00000" }),
    { target: { value: "kf-001" } },
  );
  fireEvent.click(
    picker.getByRole("button", { name: "Oak flooring · KF-001" }),
  );
  expect(dialog.getByText("Matched by your catalog selection.")).toBeVisible();
  expect(operation).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "Clear selection" }));
  expect(
    dialog.queryByRole("button", { name: "Approve matched rows" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    dialog.getByRole("button", { name: "Choose catalog product" }),
  );
  fireEvent.click(
    dialog.getByRole("button", { name: "Oak flooring · KF-001" }),
  );
  fireEvent.change(dialog.getByLabelText("Effective date"), {
    target: { value: "2026-11-20" },
  });
  fireEvent.change(dialog.getByLabelText("Price source"), {
    target: { value: "Fixture agreement" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Approve matched rows" }));
  expect(
    await dialog.findByText(
      "Saved 1 mappings and 1 prices. 0 rows were already approved.",
    ),
  ).toBeVisible();
  expect(operation).toHaveBeenCalledWith(
    "/inventory/supplier-crosswalk/approve",
    "POST",
    {
      effectiveOn: "2026-11-20",
      source: "Fixture agreement",
      rows: [
        {
          productId: "oak",
          productSku: "KF-001",
          supplier: "Fixture Supply",
          supplierSku: "00000",
          manufacturerPartNumber: "M-003",
          unit: "box",
          unitCost: "48",
        },
      ],
    },
  );
});
