import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MicrosoftFilesSettings } from "./MicrosoftFilesSettings";

const fixture = vi.hoisted(() => ({ allowed: true, operation: vi.fn(), refetch: vi.fn(), data: { configured: true, status: "connected", accountEmail: "owner@example.com", appClientId: "app-id", target: null } }));
vi.mock("wouter", () => ({ useSearch: () => "" }));
vi.mock("@/lib/operations", () => ({ operation: fixture.operation, useOperation: () => ({ allowed: fixture.allowed, data: fixture.data, isLoading: false, isError: false, refetch: fixture.refetch }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); fixture.allowed = true; });

it("requires explicit folder selection and reports rejected Microsoft folder access", async () => {
  fixture.operation.mockRejectedValue(new Error("The app does not have write access to this folder."));
  render(<MicrosoftFilesSettings />);
  expect(fixture.operation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Administrator folder setup"));
  const save = screen.getByRole("button", { name: "Verify and use folder" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Drive ID"), { target: { value: " drive-one " } });
  fireEvent.change(screen.getByLabelText("Folder ID"), { target: { value: "folder-one" } });
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("does not have write access");
  expect(fixture.operation).toHaveBeenCalledWith("/microsoft/files/target", "PUT", { driveId: "drive-one", folderId: "folder-one" });
  expect(fixture.refetch).not.toHaveBeenCalled();
});

it("disconnects only after an explicit action and explains retained copies", async () => {
  fixture.operation.mockResolvedValue(undefined);
  render(<MicrosoftFilesSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect Microsoft files" }));
  await waitFor(() => expect(fixture.refetch).toHaveBeenCalled());
  expect(await screen.findByRole("status")).toHaveTextContent("Copies already saved in Microsoft remain there");
});

it("hides connection controls from nonowners", () => {
  fixture.allowed = false;
  render(<MicrosoftFilesSettings />);
  expect(screen.queryByText("Microsoft job files")).not.toBeInTheDocument();
});
