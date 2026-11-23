import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Welcome from "@/pages/welcome";
import { StaffAccess } from "./StaffAccess";

const mocks = vi.hoisted(() => ({
  operation: vi.fn(),
  acceptInvitation: vi.fn(),
  reset: vi.fn(),
  refetch: vi.fn(),
}));
const owner = { id: "owner", name: "Current owner", email: "owner@example.test", role: "owner", active: true, invitationPending: false };
const staff = { id: "staff", name: "New teammate", email: "staff@example.test", role: "operations", active: false, invitationPending: true };
const token = "A".repeat(43);

vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: owner, acceptInvitation: mocks.acceptInvitation, reset: mocks.reset }) }));
vi.mock("@/lib/operations", () => ({
  operation: mocks.operation,
  useOperation: () => ({ data: [owner, staff], refetch: mocks.refetch }),
}));
vi.mock("@/components/layout/Brand", () => ({ ProductBrand: () => null }));

afterEach(() => { cleanup(); vi.resetAllMocks(); window.history.replaceState({}, "", "/"); });

it("lets the owner prepare a private invitation link without exposing a self-deactivation button", async () => {
  mocks.operation.mockResolvedValue({ staff, token, expiresAt: "2026-11-22T14:00:00.000Z" });
  render(<StaffAccess />);
  expect(screen.queryByRole("button", { name: "Deactivate Current owner" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: staff.name } });
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: staff.email } });
  fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
  expect(await screen.findByLabelText("Invitation link")).toHaveValue(`${window.location.origin}/welcome#invite=${token}`);
  expect(mocks.operation).toHaveBeenCalledExactlyOnceWith("/auth/staff/invitations", "POST", { name: staff.name, email: staff.email, role: staff.role });
});

it("uses the invite-only endpoint and returns the recipient to sign-in", async () => {
  window.history.replaceState({}, "", `/welcome#invite=${token}`);
  mocks.acceptInvitation.mockResolvedValue(undefined);
  mocks.operation.mockResolvedValue({ demoAccessEnabled: false });
  render(<Welcome />);
  expect(screen.getByRole("heading", { name: "Set up your account" })).toBeVisible();
  expect(window.location.hash).toBe("");
  expect(screen.queryByRole("button", { name: "Enter Demo" })).not.toBeInTheDocument();
  const password = "An example staff password";
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "Different valid password" } });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match.");
  expect(mocks.acceptInvitation).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
  expect(await screen.findByText(/Your account is ready/)).toBeVisible();
  expect(mocks.acceptInvitation).toHaveBeenCalledExactlyOnceWith(token, password);
  expect(mocks.reset).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
});

it("offers evaluation entry only when the company server explicitly enables it", async () => {
  mocks.operation.mockResolvedValue({ demoAccessEnabled: true });
  render(<Welcome />);
  expect(await screen.findByRole("button", { name: "Enter Demo" })).toBeVisible();
  expect(mocks.operation).toHaveBeenCalledWith("/auth/options");
});

it("keeps normal sign-in available without offering evaluation entry when options are unavailable", async () => {
  mocks.operation.mockRejectedValue(new Error("Unavailable"));
  render(<Welcome />);
  expect(screen.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Enter Demo" })).not.toBeInTheDocument();
  expect(screen.queryByText("Knoxville Flooring Center")).not.toBeInTheDocument();
});
