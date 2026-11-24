import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LegacyArchiveFiles } from "./LegacyArchiveFiles";
import { archiveDetail } from "@/test/legacy-history-fixtures";
const state = vi.hoisted(() => ({
  user: { role: "owner", previewRole: null } as any,
  operation: vi.fn(),
  upload: vi.fn(),
  saved: vi.fn(),
}));
vi.mock("@/contexts/auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/operations", () => ({ operation: state.operation }));
vi.mock("@/lib/legacy-history", async (original) => ({
  ...(await original<any>()),
  uploadLegacyOriginal: state.upload,
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.user = { role: "owner", previewRole: null };
  state.upload.mockResolvedValue({
    objectPath: "/objects/files/legacy-document/upload-a",
  });
});
afterEach(cleanup);

it("requires selection and original-file confirmation, then replays only the claim after a lost response", async () => {
  state.operation
    .mockRejectedValueOnce(new Error("Response interrupted"))
    .mockResolvedValueOnce({ id: "doc-a" });
  render(
    <LegacyArchiveFiles
      recordId="archive-a"
      documents={[]}
      onSaved={state.saved}
    />,
  );
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.operation).not.toHaveBeenCalled();
  const file = new File(["%PDF-1.7"], "Original.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(screen.getByLabelText("Choose an original file"), {
    target: { files: [file] },
  });
  expect(
    screen.getByRole("button", { name: "Save original file" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save original file" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Response interrupted",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save original file" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Original file saved",
  );
  expect(state.upload).toHaveBeenCalledExactlyOnceWith(file, "archive-a");
  expect(state.operation).toHaveBeenCalledTimes(2);
  expect(state.operation.mock.calls[0]).toEqual(state.operation.mock.calls[1]);
  expect(state.operation.mock.calls[0]).toEqual([
    "/legacy-history/archive-a/documents",
    "POST",
    {
      objectPath: "/objects/files/legacy-document/upload-a",
      requestKey: expect.any(String),
      confirmOriginal: true,
    },
  ]);
  expect(state.saved).toHaveBeenCalledOnce();
});
it("uses private attachment links and renders no inline preview or remote file address", () => {
  render(
    <LegacyArchiveFiles
      recordId="archive-a"
      documents={[
        ...archiveDetail.documents,
        {
          ...archiveDetail.documents[0],
          id: "remote",
          downloadUrl: "https://elsewhere.invalid/document.pdf",
        },
      ]}
      onSaved={state.saved}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Download original" }),
  ).toHaveAttribute("href", "/api/legacy-history/documents/doc-a/download");
  expect(
    screen.getByRole("link", { name: "Download original" }),
  ).toHaveAttribute("download");
  expect(screen.getByText(/Download unavailable/)).toBeVisible();
  expect(document.querySelector("iframe,img,embed,object")).toBeNull();
  expect(document.querySelector('a[href^="https:"]')).toBeNull();
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.operation).not.toHaveBeenCalled();
});
it("resets the saved file confirmation when replacing a selection and rejects unsupported files before upload", () => {
  render(
    <LegacyArchiveFiles
      recordId="archive-a"
      documents={[]}
      onSaved={state.saved}
    />,
  );
  const chooser = screen.getByLabelText("Choose an original file");
  fireEvent.change(chooser, {
    target: {
      files: [new File(["%PDF"], "One.pdf", { type: "application/pdf" })],
    },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(chooser, {
    target: {
      files: [new File(["%PDF"], "Two.pdf", { type: "application/pdf" })],
    },
  });
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Save original file" }),
  ).toBeDisabled();
  fireEvent.change(chooser, {
    target: {
      files: [new File(["bad"], "Unknown.html", { type: "text/html" })],
    },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Choose a PDF");
  expect(state.upload).not.toHaveBeenCalled();
});
it.each(["sales", "operations", "installer", "owner-preview"])(
  "does not expose original file actions to %s",
  (role) => {
    state.user =
      role === "owner-preview"
        ? { role: "owner", previewRole: "owner" }
        : { role, previewRole: null };
    render(
      <LegacyArchiveFiles
        recordId="archive-a"
        documents={archiveDetail.documents}
        onSaved={state.saved}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(state.operation).not.toHaveBeenCalled();
    expect(state.upload).not.toHaveBeenCalled();
  },
);
