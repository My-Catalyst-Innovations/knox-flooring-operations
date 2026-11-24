import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SupplierActivation, SupplierContactForm } from "./SupplierContactForm";
import { supplierContact } from "@/test/supplier-contact-fixtures";
const state = vi.hoisted(() => ({ operation: vi.fn(), saved: vi.fn() }));
vi.mock("@/lib/operations", () => ({ operation: state.operation }));
beforeEach(() => {
  vi.clearAllMocks();
  state.operation.mockReset();
});
afterEach(cleanup);
it("saves corrected contact fields with exact revision but no canonical name, ID or activation fields", async () => {
  state.operation.mockResolvedValue({ ...supplierContact, phone: "000002" });
  render(
    <SupplierContactForm
      supplier={supplierContact}
      onClose={vi.fn()}
      onSaved={state.saved}
    />,
  );
  expect(screen.queryByLabelText("Supplier name")).toBeNull();
  fireEvent.change(screen.getByLabelText("Phone"), {
    target: { value: "000002" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save supplier" }));
  await waitFor(() => expect(state.saved).toHaveBeenCalledOnce());
  const [path, method, body] = state.operation.mock.calls[0];
  expect(path).toBe(`/suppliers/${supplierContact.id}`);
  expect(method).toBe("PATCH");
  expect(body).toEqual({
    revision: 2,
    contactName: supplierContact.contactName,
    email: supplierContact.email,
    phone: "000002",
    address: supplierContact.address,
    city: supplierContact.city,
    state: supplierContact.state,
    postalCode: supplierContact.postalCode,
    country: supplierContact.country,
    notes: supplierContact.notes,
  });
});
it("keeps a stale contact edit unsaved and reports the API conflict", async () => {
  state.operation.mockRejectedValue(
    new Error("Supplier revision changed. Refresh."),
  );
  render(
    <SupplierContactForm
      supplier={supplierContact}
      onClose={vi.fn()}
      onSaved={state.saved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save supplier" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Supplier revision changed",
  );
  expect(state.saved).not.toHaveBeenCalled();
});
it("adds a manual supplier only on explicit save", async () => {
  state.operation.mockResolvedValue(supplierContact);
  render(<SupplierContactForm onClose={vi.fn()} onSaved={state.saved} />);
  expect(state.operation).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Supplier name"), {
    target: { value: "New Supply" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save supplier" }));
  await waitFor(() => expect(state.saved).toHaveBeenCalledOnce());
  expect(state.operation).toHaveBeenCalledWith(
    "/suppliers",
    "POST",
    expect.objectContaining({ name: "New Supply", phone: "" }),
  );
});
it.each([true, false])(
  "requires an explicit reason for activation change from active=%s",
  async (active) => {
    state.operation.mockResolvedValue({ ...supplierContact, active: !active });
    render(
      <SupplierActivation
        supplier={{ ...supplierContact, active }}
        onClose={vi.fn()}
        onSaved={state.saved}
      />,
    );
    const save = screen.getByRole("button", {
      name: active ? "Confirm deactivation" : "Confirm reactivation",
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Owner verified this status change" },
    });
    expect(state.operation).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(state.saved).toHaveBeenCalledOnce());
    expect(state.operation).toHaveBeenCalledWith(
      `/suppliers/${supplierContact.id}/activation`,
      "POST",
      {
        revision: 2,
        active: !active,
        reason: "Owner verified this status change",
      },
    );
  },
);
