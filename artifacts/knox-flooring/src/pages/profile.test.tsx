import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProfilePage from "./profile";

const state = vi.hoisted(() => ({
  profile: { id: "installer", name: "Sam Test", email: "sam@example.test", phone: "", jobTitle: "Installer", role: "installer" },
  previewRole: null as string | null, operation: vi.fn(), refresh: vi.fn(), refetch: vi.fn(),
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: { previewRole: state.previewRole }, refreshSession: state.refresh }) }));
vi.mock("@/lib/operations", () => ({ operation: state.operation, useOperation: () => ({ data: state.profile, refetch: state.refetch, isLoading: false, error: null }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); state.previewRole = null; });

it("lets invited staff update personal details without editing their email or role", async () => {
  state.operation.mockResolvedValue(state.profile);
  render(<ProfilePage />);
  expect(screen.getByLabelText("Sign-in email")).toHaveAttribute("readonly");
  expect(screen.getByText("Access role: installer")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Sam Installer" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+1 (865) 555-0100" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Profile saved.");
  expect(state.operation).toHaveBeenCalledWith("/auth/profile", "PATCH", { name: "Sam Installer", phone: "+1 (865) 555-0100", jobTitle: "Installer" });
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("retains an unsaved edit and exposes a failed save", async () => {
  state.operation.mockRejectedValue(new Error("Try again later."));
  render(<ProfilePage />);
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Unsaved name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again later.");
  expect(screen.getByLabelText("Full name")).toHaveValue("Unsaved name");
  await waitFor(() => expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled());
});

it("prevents changing an account while the owner is previewing another role", () => {
  state.previewRole = "installer";
  render(<ProfilePage />);
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Preview name" } });
  expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Exit role preview");
});
