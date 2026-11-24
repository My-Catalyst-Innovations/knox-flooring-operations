import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OriginalBillDocuments } from "./OriginalBillDocuments";
const state = vi.hoisted(() => ({
  operation: vi.fn(),
  upload: vi.fn(),
  saved: vi.fn(),
}));
vi.mock("@/lib/operations", () => ({ operation: state.operation }));
vi.mock("@/lib/receipt-bill-coverage", async (original) => ({
  ...(await original<any>()),
  uploadBillOriginal: state.upload,
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.upload.mockResolvedValue({
    objectPath: "/objects/files/vendor-bill-document/upload-a",
  });
  state.saved.mockResolvedValue(undefined);
});
afterEach(cleanup);
function choose() {
  fireEvent.change(screen.getByLabelText("Original bill PDF or image"), {
    target: {
      files: [
        new File(["%PDF"], "Original #001.pdf", { type: "application/pdf" }),
      ],
    },
  });
}
it("does not upload on opening and requires an explicit original-file confirmation", async () => {
  state.operation.mockResolvedValue({ id: "document" });
  render(
    <OriginalBillDocuments
      billId="bill-a"
      documents={[]}
      onSaved={state.saved}
    />,
  );
  expect(state.upload).not.toHaveBeenCalled();
  choose();
  const save = screen.getByRole("button", { name: "Save original bill file" });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(save);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Original bill file saved privately in Works",
  );
  expect(state.operation).toHaveBeenCalledWith(
    "/quickbooks/vendor-bills/bill-a/documents",
    "POST",
    {
      objectPath: "/objects/files/vendor-bill-document/upload-a",
      requestKey: expect.any(String),
    },
  );
  expect(state.saved).toHaveBeenCalledOnce();
  expect(state.upload).toHaveBeenCalledOnce();
});
it("replays the same original-file claim after uncertainty without uploading the file twice", async () => {
  state.operation
    .mockRejectedValueOnce(new Error("lost response"))
    .mockRejectedValueOnce(
      Object.assign(new Error("Sign in again"), {
        name: "ApiError",
        status: 401,
      }),
    )
    .mockResolvedValueOnce({ id: "document" });
  render(
    <OriginalBillDocuments
      billId="bill-a"
      documents={[]}
      onSaved={state.saved}
    />,
  );
  choose();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Save original bill file" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "confirmation is unknown",
  );
  expect(screen.getByLabelText("Original bill PDF or image")).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry original confirmation" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "confirmation is unknown",
  );
  expect(screen.getByLabelText("Original bill PDF or image")).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry original confirmation" }),
  );
  await screen.findByRole("status");
  expect(state.upload).toHaveBeenCalledOnce();
  expect(state.operation.mock.calls[0]).toEqual(state.operation.mock.calls[1]);
  expect(state.operation.mock.calls[0]).toEqual(state.operation.mock.calls[2]);
});
it("clears a prior selected original and its confirmation when the replacement file is invalid", () => {
  render(
    <OriginalBillDocuments
      billId="bill-a"
      documents={[]}
      onSaved={state.saved}
    />,
  );
  choose();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Original bill PDF or image"), {
    target: {
      files: [new File(["<script>"], "Wrong.html", { type: "text/html" })],
    },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("PDF, JPEG or PNG");
  expect(
    screen.getByRole("button", { name: "Save original bill file" }),
  ).toBeDisabled();
  expect(screen.queryByText(/Selected:/)).toBeNull();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(state.upload).not.toHaveBeenCalled();
});
it("renders plain file provenance and exact authenticated attachment links without inline previews", () => {
  const doc = {
    id: "doc-a",
    billId: "bill-a",
    fileName: "<script>alert(1)</script>.pdf",
    size: 4,
    sha256: "a".repeat(64),
    createdAt: "2026-11-23T12:00:00Z",
    downloadUrl: "/api/quickbooks/vendor-bills/documents/doc-a/download",
  };
  render(
    <OriginalBillDocuments
      billId="bill-a"
      documents={[
        doc,
        { ...doc, id: "remote", downloadUrl: "https://elsewhere.invalid/file" },
        { ...doc, id: "wrong", billId: "other" },
      ]}
      onSaved={state.saved}
    />,
  );
  expect(screen.getAllByText(/<script>alert/)).toHaveLength(3);
  expect(
    screen.getByRole("link", { name: "Download original bill" }),
  ).toHaveAttribute("href", doc.downloadUrl);
  expect(screen.getByRole("link")).toHaveAttribute("download");
  expect(document.querySelector("iframe,img,embed,object,script")).toBeNull();
  expect(state.operation).not.toHaveBeenCalled();
  expect(state.upload).not.toHaveBeenCalled();
});
