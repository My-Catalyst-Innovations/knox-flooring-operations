import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getMicrosoftFilesAuthorization, getMicrosoftFilesConfig, hasSelectedFilesScope, MicrosoftFilesError, microsoftFilesGraph, permissionAllowsSelectedWrite, quickXorHash, safeMicrosoftName, safeMicrosoftWebUrl, startMicrosoftFilesAuthorization, verifyMirroredItem } from "./microsoft-files-graph";
import { openOutlookSecret, sealOutlookSecret } from "./outlook-graph";
const env = { MICROSOFT_FILES_CLIENT_ID: "selected-files-app", MICROSOFT_FILES_CLIENT_SECRET: "synthetic", MICROSOFT_FILES_REDIRECT_URI: "https://works.example.test/api/microsoft/files/callback", MICROSOFT_FILES_ENCRYPTION_KEY: "synthetic-files-encryption-key-for-unit-tests" };
const config = getMicrosoftFilesConfig(env)!;
const bytes = Buffer.from("%PDF-1.7\nFictional installation document");
const item = { id: "actual-item", name: "immutable-file.pdf", size: bytes.length, parentReference: { id: "job-folder", driveId: "drive" }, file: { hashes: { quickXorHash: quickXorHash(bytes) } } };
describe("Microsoft selected file authorization", () => {
  it("requests only selected resources with PKCE and binds encrypted state to company, registration, owner and session", () => {
    const auth = startMicrosoftFilesAuthorization(config, "owner", "csrf"), url = new URL(auth.authorizationUrl), state = url.searchParams.get("state")!;
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Files.SelectedOperations.Selected");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(getMicrosoftFilesAuthorization(config, auth.cookie, state, "owner", "csrf")).toBeTruthy();
    expect(getMicrosoftFilesAuthorization(config, auth.cookie, state, "other-owner", "csrf")).toBeNull();
    expect(getMicrosoftFilesAuthorization(config, auth.cookie, state, "owner", "other-session")).toBeNull();
    const other = getMicrosoftFilesConfig({ ...env, MICROSOFT_FILES_REDIRECT_URI: "https://other.example.test/api/microsoft/files/callback" })!;
    expect(getMicrosoftFilesAuthorization(other, auth.cookie, state, "owner", "csrf")).toBeNull();
    expect(() => openOutlookSecret(other, sealOutlookSecret(config, "refresh", "microsoft-files:account:refresh"), "microsoft-files:account:refresh")).toThrow();
    expect(getMicrosoftFilesConfig({ ...env, MICROSOFT_FILES_TENANT_ID: "consumers" })).toBeNull();
    expect(hasSelectedFilesScope("User.Read")).toBe(false);
    expect(hasSelectedFilesScope("https://graph.microsoft.com/Files.SelectedOperations.Selected")).toBe(true);
  });
  it("requires the selected app's actual write permission and never substitutes the signed-in user's unrelated sharing role", async () => {
    expect(permissionAllowsSelectedWrite({ roles: ["write"], grantedToV2: { application: { id: config.clientId } } }, config.clientId)).toBe(true);
    expect(permissionAllowsSelectedWrite({ roles: ["read"], grantedTo: { application: { id: config.clientId } } }, config.clientId)).toBe(false);
    expect(permissionAllowsSelectedWrite({ roles: ["owner"], grantedTo: { application: { id: "another-app" } } }, config.clientId)).toBe(false);
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "folder", name: "Approved", folder: {} }))
      .mockResolvedValueOnce(Response.json({ value: [{ roles: ["write"], grantedToV2: { application: { id: "another-app" } } }] }));
    await expect(microsoftFilesGraph("fake", request).target("drive", "folder", config.clientId)).rejects.toMatchObject({ status: 403 });
    expect(request.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    expect(request.mock.calls.every(([url]) => !String(url).includes("/permissions/") && String(url).startsWith("https://graph.microsoft.com/v1.0/drives/drive/items/folder"))).toBe(true);
  });
});
describe("Microsoft attachment safety and integrity", () => {
  it("lists only actual child folders and binds every continuation to the approved parent",async()=>{
    const child={id:"child",name:"Customer jobs",folder:{},parentReference:{id:"approved",driveId:"drive"}};
    const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({value:[child,{id:"file",name:"Private report.pdf",file:{}},{...child,id:"shortcut",remoteItem:{}}],"@odata.nextLink":"https://graph.microsoft.com/v1.0/drives/drive/items/approved/children?$skiptoken=next"})).mockResolvedValueOnce(Response.json({value:[]}));
    expect(await microsoftFilesGraph("synthetic",request).folders("drive","approved")).toEqual({folders:[child],complete:true});
    expect(request.mock.calls.every(([,options])=>!options?.method||options.method==="GET")).toBe(true);
    const invalid=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({value:[],"@odata.nextLink":"https://graph.microsoft.com/v1.0/drives/another/items/outside/children"}));
    await expect(microsoftFilesGraph("synthetic",invalid).folders("drive","approved")).rejects.toThrow(/continuation/);expect(invalid).toHaveBeenCalledTimes(1);
    const moved=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({value:[{...child,parentReference:{id:"elsewhere",driveId:"drive"}}]}));await expect(microsoftFilesGraph("synthetic",moved).folders("drive","approved")).rejects.toThrow(/outside/);
  });
  it.each([["", "AAAAAAAAAAAAAAAAAAAAAAAAAAA="], ["a", "YQAAAAAAAAAAAAAAAQAAAAAAAAA="], ["Hello World!", "SCgDG9jwBhBc4Q1ybAMZQgAAAAA="], ["flooring".repeat(40), "AAAAAAAAAAAAAAAAQAEAAAAAAAA="]])("matches independent .NET reference vectors for QuickXor checksums", (value, expected) => {
    expect(quickXorHash(Buffer.from(value))).toBe(expected);
  });
  it("verifies exact parent, drive, filename, size and content checksum; URL and filename validation exclude untrusted hosts and path traversal", () => {
    expect(() => verifyMirroredItem(item, "job-folder", "drive", item.name, bytes)).not.toThrow();
    expect(() => verifyMirroredItem({ ...item, parentReference: { id: "another-folder", driveId: "drive" } }, "job-folder", "drive", item.name, bytes)).toThrow();
    expect(() => verifyMirroredItem({ ...item, file: { hashes: { quickXorHash: quickXorHash(Buffer.from("different bytes")) } } }, "job-folder", "drive", item.name, bytes)).toThrow();
    expect(() => verifyMirroredItem({ ...item, file: { hashes: { sha1Hash: createHash("sha1").update(bytes).digest("hex") } } }, "job-folder", "drive", item.name, bytes)).not.toThrow();
    expect(safeMicrosoftName("../../quote:unsafe.pdf")).not.toMatch(/[\\/:]/);
    expect(safeMicrosoftWebUrl("https://company.sharepoint.com/sites/flooring/doc.pdf")).toBeTruthy();
    expect(safeMicrosoftWebUrl("https://company.sharepoint.com.evil.test/file")).toBeNull();
    expect(safeMicrosoftWebUrl("https://user:password@company.sharepoint.com/file")).toBeNull();
    expect(safeMicrosoftWebUrl("javascript:alert(1)")).toBeNull();
  });
  it("creates folders and uploads only with fail-on-conflict, never overwrites or follows redirected download URLs", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "actual-folder", name: "Job", folder: {} }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(item, { status: 201 })).mockResolvedValueOnce(new Response(null, { status: 409 })).mockRejectedValueOnce(new Error("response lost"));
    const graph = microsoftFilesGraph("fake", request);
    await graph.folder("drive", "root", "Job");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))["@microsoft.graph.conflictBehavior"]).toBe("fail");
    await graph.upload("drive", "job-folder", item.name, bytes);
    expect(String(request.mock.calls[1][0])).toContain("conflictBehavior=fail");
    expect(new Headers(request.mock.calls[1][1]?.headers).get("If-None-Match")).toBe("*");
    expect(request.mock.calls[1][1]?.redirect).toBe("error");
    await expect(graph.upload("drive", "job-folder", item.name, bytes)).rejects.toMatchObject({ status: 409, uncertain: false });
    await expect(graph.upload("drive", "job-folder", item.name, bytes)).rejects.toMatchObject({ status: 502, uncertain: true });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("rejects unbounded permission continuations rather than forwarding a token to a supplied URL", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ id: "folder", name: "Folder", folder: {} }))
      .mockResolvedValueOnce(Response.json({ value: [], "@odata.nextLink": "https://evil.test/permissions" }));
    await expect(microsoftFilesGraph("fake", request).target("drive", "folder", config.clientId)).rejects.toBeInstanceOf(MicrosoftFilesError);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
