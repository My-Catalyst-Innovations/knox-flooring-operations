import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { assertOwnedFile, canUploadFile, createAzureFileStore, filePurpose, isPortalPhoto, publishedLogoUrl, safeFileHeaders, uploadContentType } from "./file-store";

const account = "https://exampleaccount.blob.core.windows.net";
const fileId = "62d2b13f-4ca2-4a89-b5ae-29cbd61f2df6";
const key = `files/job-photo/${fileId}`;
const metadata = { uploader: "user-1", recordId: "job-1", name: "Hallway.jpg", uploadedAt: "2026-11-20T15:00:00.000Z" };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("Azure storage contract", () => {
  it("obtains one managed identity token, creates an immutable blob and reads metadata and bytes in the named container", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "fake-identity-token", expires_on: Math.floor(Date.now() / 1000) + 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { headers: Object.fromEntries(
        Object.entries(metadata).map(([field, value]) => [`x-ms-meta-${field.toLowerCase()}`, Buffer.from(value).toString("base64url")]),
      ) }))
      .mockResolvedValueOnce(new Response(jpeg, { headers: { "content-type": "image/jpeg", "content-length": "4" } }));
    const storage = createAzureFileStore(account, "private-files", "http://127.0.0.1:8081/token", "fake-identity-header", request);

    await storage.put(key, jpeg, "image/jpeg", metadata);
    await expect(storage.metadata(key)).resolves.toEqual(metadata);
    const downloaded = await storage.get(key);
    expect(downloaded?.length).toBe("4");
    const chunks: Uint8Array[] = [];
    for await (const chunk of downloaded!.body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(jpeg);

    const [tokenCall, putCall, headCall, getCall] = request.mock.calls;
    expect(String(tokenCall[0])).toBe("http://127.0.0.1:8081/token?resource=https%3A%2F%2Fstorage.azure.com%2F&api-version=2019-08-01");
    expect(tokenCall[1]).toMatchObject({ headers: { "X-IDENTITY-HEADER": "fake-identity-header" }, redirect: "error" });
    expect(putCall[1]).toMatchObject({
      method: "PUT",
      headers: { "If-None-Match": "*", "x-ms-blob-type": "BlockBlob", Authorization: "Bearer fake-identity-token" },
      body: jpeg,
      redirect: "error",
    });
    for (const [url] of [putCall, headCall, getCall]) expect(url).toBe(`${account}/private-files/${key}`);
    expect(headCall[1]?.method).toBe("HEAD");
    expect(getCall[1]?.method).toBe("GET");
  });

  it("reports Azure permission and configuration failures separately from a missing blob", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "test", expires_on: Math.floor(Date.now() / 1000) + 3600 }))
      .mockResolvedValueOnce(new Response(null, { status: 404, headers: { "x-ms-error-code": "BlobNotFound" } }))
      .mockResolvedValueOnce(new Response(null, { status: 403, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } }))
      .mockResolvedValueOnce(new Response(null, { status: 412, headers: { "x-ms-error-code": "ConditionNotMet" } }));
    const storage = createAzureFileStore(account, "private-files", "http://127.0.0.1:8081/token", "test", request);
    await expect(storage.get(key)).resolves.toBeNull();
    await expect(storage.metadata(key)).rejects.toThrow("AuthorizationPermissionMismatch");
    await expect(storage.put(key, jpeg, "image/jpeg", metadata)).rejects.toMatchObject({ status: 409 });
    expect(() => createAzureFileStore("https://example.com", "private-files", "http://localhost/token", "test", request)).toThrow();
  });
});

describe("file safety", () => {
  it("uses a strict path and scope allowlist", () => {
    expect(filePurpose(`/objects/${key}`)).toBe("job-photo");
    expect(filePurpose(`/objects/files/job-photo/../${fileId}`)).toBeNull();
    expect(filePurpose(`/objects/files/unrecognized/${fileId}`)).toBeNull();
    expect(canUploadFile("lead-document", "installer")).toBe(false);
    expect(canUploadFile("job-document", "installer")).toBe(false);
    expect(canUploadFile("job-document", "operations")).toBe(true);
    expect(filePurpose(`/objects/files/job-document/${fileId}`)).toBe("job-document");
    expect(canUploadFile("product-image", "sales")).toBe(false);
    expect(isPortalPhoto(`/objects/${key}`)).toBe(false);
    expect(isPortalPhoto(`/objects/uploads/${fileId}`)).toBe(false);
    expect(isPortalPhoto(`/objects/files/portal-photo/${fileId}`)).toBe(true);
    expect(publishedLogoUrl(`/api/storage/objects/${key}`)).toBeNull();
    expect(publishedLogoUrl(`/api/storage/objects/files/company-logo/${fileId}`)).toBe("/api/public/company-logo");
  });

  it("allows only recognized raster images inline and forces attachments to download", () => {
    expect(uploadContentType("job-photo", jpeg)).toBe("image/jpeg");
    expect(() => uploadContentType("job-photo", Buffer.from("<svg></svg>"))).toThrow();
    expect(uploadContentType("lead-document", jpeg)).toBe("application/octet-stream");
    expect(uploadContentType("job-document", Buffer.from("%PDF-1.7\njob document"))).toBe("application/octet-stream");
    const image = { body: Readable.from(jpeg), type: "image/jpeg", name: "floor.jpg" };
    expect(safeFileHeaders(image, false)).toMatchObject({ "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" });
    const headers = safeFileHeaders({ ...image, name: "a\r\nB.pdf" }, true);
    expect(headers).toMatchObject({ "Content-Disposition": "attachment; filename*=UTF-8''a__B.pdf", "Content-Type": "application/octet-stream" });
    expect(safeFileHeaders({ ...image, type: "text/html" }, false)["Content-Type"]).toBe("application/octet-stream");
  });

  it("binds an attachment to the uploader, file purpose and target record", async () => {
    vi.stubEnv("AZURE_STORAGE_ACCOUNT_URL", account);
    vi.stubEnv("AZURE_STORAGE_CONTAINER", "private-files");
    vi.stubEnv("IDENTITY_ENDPOINT", "http://127.0.0.1:8081/token");
    vi.stubEnv("IDENTITY_HEADER", "fake-identity-header");
    const headers = Object.fromEntries(
      Object.entries(metadata).map(([field, value]) => [`x-ms-meta-${field.toLowerCase()}`, Buffer.from(value).toString("base64url")]),
    );
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === "HEAD"
      ? new Response(null, { headers })
      : Response.json({ access_token: "fake-identity-token", expires_on: Math.floor(Date.now() / 1000) + 3600 }));
    vi.stubGlobal("fetch", request);
    try {
      const path = `/objects/${key}`;
      await expect(assertOwnedFile(path, ["job-photo"], "user-1", "job-1")).resolves.toBeUndefined();
      await expect(assertOwnedFile(path, ["job-photo"], "user-2", "job-1")).rejects.toMatchObject({ status: 400 });
      await expect(assertOwnedFile(path, ["job-photo"], "user-1", "job-2")).rejects.toMatchObject({ status: 400 });
      await expect(assertOwnedFile(path, ["company-logo"], "user-1", "job-1")).rejects.toMatchObject({ status: 400 });
      expect(request).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
