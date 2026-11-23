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

it("previews pasted CSV without a file and imports only its explicitly reviewed key", async () => {
  const pasted =
    "internal_sku,name,category,unit,unit_cost,sale_price,warehouse,on_hand\n00014,Slate,Tile,box,48,75,,0";
  operation
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce({ created: 1 });
  render(<CatalogImportDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Import products" }));
  fireEvent.change(screen.getByLabelText("Paste catalog CSV"), {
    target: { value: pasted },
  });
  expect(operation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview pasted CSV" }));
  const confirm = await screen.findByRole("button", {
    name: "Import 1 product",
  });
  expect(screen.getByText("00014")).toBeVisible();
  expect(operation).toHaveBeenCalledExactlyOnceWith(
    "/products/catalog-import/preview",
    "POST",
    { csv: pasted },
  );
  fireEvent.click(confirm);
  expect(
    await screen.findByText("Imported 1 product into Inventory."),
  ).toBeVisible();
  expect(operation).toHaveBeenLastCalledWith(
    "/products/catalog-import",
    "POST",
    { csv: pasted, previewKey: preview.previewKey },
  );
});

it("invalidates the prior preview after pasted text edits and requires a fresh preview", async () => {
  operation
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce({ ...preview, previewKey: "updated-preview" })
    .mockResolvedValueOnce({ created: 1 });
  render(<CatalogImportDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Import products" }));
  const input = screen.getByLabelText("Paste catalog CSV");
  fireEvent.change(input, { target: { value: csv } });
  fireEvent.click(screen.getByRole("button", { name: "Preview pasted CSV" }));
  await screen.findByRole("button", { name: "Import 1 product" });
  const edited = csv.replace(",48,75", ",49,75");
  fireEvent.change(input, { target: { value: edited } });
  expect(
    screen.queryByRole("button", { name: "Import 1 product" }),
  ).not.toBeInTheDocument();
  expect(operation).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Preview pasted CSV" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Import 1 product" }),
  );
  await waitFor(() =>
    expect(operation).toHaveBeenLastCalledWith(
      "/products/catalog-import",
      "POST",
      { csv: edited, previewKey: "updated-preview" },
    ),
  );
});

it("retains the server row-limit rejection and blocks oversized pasted input before a request", async () => {
  operation.mockRejectedValueOnce(
    new Error("Import up to 1,000 rows at a time."),
  );
  render(<CatalogImportDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Import products" }));
  const input = screen.getByLabelText("Paste catalog CSV");
  fireEvent.change(input, { target: { value: csv } });
  fireEvent.click(screen.getByRole("button", { name: "Preview pasted CSV" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("1,000 rows");
  expect(
    screen.queryByRole("button", { name: "Import 1 product" }),
  ).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "x".repeat(200_001) } });
  fireEvent.click(screen.getByRole("button", { name: "Preview pasted CSV" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("200 KB");
  expect(operation).toHaveBeenCalledTimes(1);
});
