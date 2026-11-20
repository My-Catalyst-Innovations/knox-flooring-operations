import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CatalogImportPreview } from "@workspace/domain";
import { CatalogImportDialog } from "./CatalogImportDialog";

const { operation, refresh } = vi.hoisted(() => ({
  operation: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/operations", () => ({
  operation,
  useRefreshOperations: () => refresh,
}));

const csv =
  "internal_sku,name,category,unit,unit_cost,sale_price\n00014,Slate,Tile,box,48,75";
const preview: CatalogImportPreview = {
  rows: [
    {
      line: 2,
      sku: "00014",
      name: "Slate",
      warehouse: "",
      onHand: 0,
      unit: "box",
      unitCost: 48,
      salePrice: 75,
      status: "new",
    },
  ],
  newProducts: 1,
  errors: [],
  previewKey: "confirmed-file-preview",
};

function uploadCatalog() {
  render(<CatalogImportDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Import products" }));
  const file = new File([csv], "catalog.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => csv });
  fireEvent.change(screen.getByLabelText("Catalog CSV"), {
    target: { files: [file] },
  });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("previews the file, then sends its reviewed file key on explicit confirmation", async () => {
  operation
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce({ created: 1 });
  uploadCatalog();

  const confirm = await screen.findByRole("button", {
    name: "Import 1 product",
  });
  expect(screen.getByText("00014")).toBeInTheDocument();
  expect(operation).toHaveBeenCalledExactlyOnceWith(
    "/products/catalog-import/preview",
    "POST",
    { csv },
  );
  fireEvent.click(confirm);

  expect(
    await screen.findByText("Imported 1 product into Inventory."),
  ).toBeInTheDocument();
  expect(operation).toHaveBeenLastCalledWith(
    "/products/catalog-import",
    "POST",
    { csv, previewKey: preview.previewKey },
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
});

it("keeps the import disabled when any row requires correction", async () => {
  operation.mockResolvedValueOnce({
    ...preview,
    rows: [
      ...preview.rows,
      {
        ...preview.rows[0],
        line: 3,
        status: "error",
        message: "Warehouse not found.",
      },
    ],
  });
  uploadCatalog();

  expect(await screen.findByText("Warehouse not found.")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Import 1 product" }),
  ).toBeDisabled();
  expect(operation).toHaveBeenCalledTimes(1);
});
