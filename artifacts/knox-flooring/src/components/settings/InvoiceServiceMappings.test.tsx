import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InvoiceServiceMappings } from "./InvoiceServiceMappings";

const { customFetch } = vi.hoisted(() => ({ customFetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ customFetch }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const settings = {
  connectionId: "connection-1",
  mappings: [
    { category: "Labor", itemId: null },
    { category: "Add-on", itemId: null },
    { category: "Materials", itemId: null },
  ],
};
const catalog = {
  connectionId: settings.connectionId,
  items: [
    { Id: "41", Name: "Install labor", Type: "Service", Active: true },
    { Id: "42", Name: "Discontinued service", Type: "Service", Active: false },
    { Id: "43", Name: "Tile stock", Type: "Inventory", Active: true },
  ],
};

it("requires an explicit approval for active service items and supports clearing it", async () => {
  customFetch.mockResolvedValueOnce(settings)
    .mockResolvedValueOnce({ category: "Labor", itemId: "41" })
    .mockResolvedValueOnce({ category: "Labor", itemId: null });
  render(<InvoiceServiceMappings catalog={catalog} />);

  const labor = await screen.findByLabelText("Labor");
  expect(screen.queryByRole("option", { name: /Discontinued service|Tile stock/ })).not.toBeInTheDocument();
  fireEvent.change(labor, { target: { value: "41" } });
  expect(customFetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Approve Labor service item" }));

  expect(await screen.findByText("Approved Install labor")).toBeVisible();
  expect(customFetch).toHaveBeenLastCalledWith("/api/quickbooks/invoice-service-mappings/Labor", {
    method: "PUT",
    body: JSON.stringify({ connectionId: settings.connectionId, itemId: "41" }),
    responseType: "json",
  });
  fireEvent.click(screen.getByRole("button", { name: "Clear Labor service item" }));
  expect(await screen.findByText("Labor service item cleared.")).toBeVisible();
  expect(customFetch).toHaveBeenLastCalledWith("/api/quickbooks/invoice-service-mappings/Labor", {
    method: "PUT",
    body: JSON.stringify({ connectionId: settings.connectionId, itemId: null }),
    responseType: "json",
  });
});

it("does not offer service items imported under a different connection", async () => {
  customFetch.mockResolvedValueOnce(settings);
  render(<InvoiceServiceMappings catalog={{ ...catalog, connectionId: "old-connection" }} />);

  expect(await screen.findByLabelText("Labor")).toBeDisabled();
  expect(screen.queryByRole("option", { name: /Install labor/ })).not.toBeInTheDocument();
  expect(screen.getByText(/Use Import & reconcile/)).toBeVisible();
});
