import { beforeEach, expect, it, vi } from "vitest";
import {
  legacyDocumentDownload,
  legacyArchiveLabel,
  readLegacyCsv,
  uploadLegacyOriginal,
} from "./legacy-history";
const request = vi.hoisted(() => vi.fn());
vi.mock("@workspace/api-client-react", () => ({ customFetch: request }));
beforeEach(() => vi.clearAllMocks());
it("treats unsupported historical types as text, including inherited object-property names", () => {
  expect(legacyArchiveLabel("invoice")).toBe("Invoice");
  expect(legacyArchiveLabel("__proto__")).toBe("__proto__");
  expect(legacyArchiveLabel("constructor")).toBe("constructor");
});

it("retains UTF-8 BOM, CRLF and leading-zero source IDs without reinterpretation", async () => {
  const source =
    "\uFEFFsource_id,type,title\r\n00001,invoice,Historical record\r\n";
  const bytes = new TextEncoder().encode(source);
  expect(
    await readLegacyCsv({
      size: bytes.length,
      arrayBuffer: async () => bytes.buffer,
    } as File),
  ).toBe(source);
  const invalid = new Uint8Array([0xff]);
  await expect(
    readLegacyCsv({ size: 1, arrayBuffer: async () => invalid.buffer } as File),
  ).rejects.toThrow("UTF-8");
});
it("bounds file reads before loading bytes and never accepts a remote download URL", async () => {
  const arrayBuffer = vi.fn();
  await expect(
    readLegacyCsv({ size: 1_048_577, arrayBuffer } as unknown as File),
  ).rejects.toThrow("1 MiB");
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(
    legacyDocumentDownload({
      id: "doc-a",
      downloadUrl: "/api/legacy-history/documents/doc-a/download",
    }),
  ).toBe("/api/legacy-history/documents/doc-a/download");
  for (const downloadUrl of [
    "https://elsewhere.invalid/original.pdf",
    "//elsewhere.invalid/x",
    "/api/storage/objects/private",
    "/api/legacy-history/documents/doc-b/download",
    "/api/legacy-history/documents/doc-a/download?public=true",
  ])
    expect(legacyDocumentDownload({ id: "doc-a", downloadUrl })).toBeNull();
});
it("uploads only an explicitly chosen supported original to the record-bound private route", async () => {
  const file = new File(["%PDF-1.7"], "Original invoice #1.pdf", {
    type: "application/pdf",
  });
  request.mockResolvedValue({
    objectPath: "/objects/files/legacy-document/private",
  });
  await uploadLegacyOriginal(file, "archive/a");
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "/api/storage/files/legacy-document?recordId=archive%2Fa",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": "Original%20invoice%20%231.pdf",
      },
      body: file,
      responseType: "json",
    },
  );
  request.mockClear();
  await expect(
    uploadLegacyOriginal(
      new File(["<script>bad</script>"], "source.html", { type: "text/html" }),
      "archive-a",
    ),
  ).rejects.toThrow("supported image");
  expect(request).not.toHaveBeenCalled();
});
