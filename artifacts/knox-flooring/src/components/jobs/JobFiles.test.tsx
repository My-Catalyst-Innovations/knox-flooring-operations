import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JobFiles } from "./JobFiles";

const fixture = vi.hoisted(() => ({
  role: "owner", operation: vi.fn(), refetch: vi.fn(),
  data: { documents: [{ id: "doc-1", jobId: "job-1", name: "Customer plan.pdf", objectPath: "/objects/files/job-document/test", size: 100, sha256: "sha", createdAt: "2026-11-23" }], photos: [],
    microsoft: { connected: true, targetReady: true, folderUrl: null, mirrors: [] as { sourceType: string; sourceId: string; status: string; webUrl: string; lastError: string | null }[] } },
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: { role: fixture.role } }) }));
vi.mock("@/lib/operations", () => ({ operation: fixture.operation, useOperation: () => ({ allowed: ["owner", "sales", "operations"].includes(fixture.role), data: fixture.data, isLoading: false, isError: false, refetch: fixture.refetch }) }));
vi.mock("@/lib/file-upload", () => ({ fileSrc: (path: string) => `/api/storage${path}`, useStoredFileUpload: () => ({ isUploading: false, uploadFile: vi.fn() }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); fixture.role = "owner"; fixture.data.microsoft.mirrors = []; });

it("only copies the chosen source after explicit action, with a fresh idempotency key", async () => {
  fixture.operation.mockResolvedValue({ status: "synced" });
  render(<JobFiles jobId="job-1" />);
  expect(fixture.operation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Copy to Microsoft" }));
  await waitFor(() => expect(fixture.refetch).toHaveBeenCalled());
  expect(fixture.operation).toHaveBeenCalledWith("/jobs/job-1/microsoft-files/sync", "POST", { sourceType: "document", sourceId: "doc-1", idempotencyKey: expect.any(String) });
});

it("keeps an unknown previous result visible for reconciliation and rejects untrusted links", () => {
  fixture.data.microsoft.mirrors = [{ sourceType: "document", sourceId: "doc-1", status: "unknown", webUrl: "https://attacker.example/file", lastError: "Microsoft did not confirm the previous request." }];
  render(<JobFiles jobId="job-1" />);
  expect(screen.getByRole("button", { name: "Check previous copy" })).toBeEnabled();
  expect(screen.getByText("Microsoft did not confirm the previous request.")).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open in Microsoft" })).not.toBeInTheDocument();
});

it("allows sales to read files without offering Microsoft write actions", () => {
  fixture.role = "sales";
  render(<JobFiles jobId="job-1" />);
  expect(screen.getByRole("link", { name: "Open file" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Copy to Microsoft" })).not.toBeInTheDocument();
});

it("does not display office documents in installer view", () => {
  fixture.role = "installer";
  render(<JobFiles jobId="job-1" />);
  expect(screen.queryByText("Customer plan.pdf")).not.toBeInTheDocument();
});
