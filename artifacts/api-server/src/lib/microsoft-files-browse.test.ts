import { describe,expect,it,vi } from "vitest";
import { assertMicrosoftFolderUnderRoot,browseApprovedMicrosoftFolders } from "./microsoft-files-browse";
import { getMicrosoftFilesApprovedRoot } from "./microsoft-files-graph";
const root={driveId:"approved-drive",folderId:"root"};
const folder=(id:string,parent="root")=>({id,name:id,folder:{},parentReference:{driveId:root.driveId,id:parent},webUrl:`https://company.sharepoint.com/Docs/${id}`});
const graph=()=>({target:vi.fn().mockResolvedValue(folder("root","library")),folders:vi.fn().mockResolvedValue({folders:[folder("child")],complete:true}),item:vi.fn()});
describe("approved Microsoft folder navigation",()=>{
  it("requires paired bounded root IDs and does not treat a partly configured root as unrestricted",()=>{
    expect(getMicrosoftFilesApprovedRoot({})).toBeNull();
    expect(getMicrosoftFilesApprovedRoot({MICROSOFT_FILES_ROOT_DRIVE_ID:"drive",MICROSOFT_FILES_ROOT_FOLDER_ID:"folder"})).toEqual({driveId:"drive",folderId:"folder"});
    for(const env of [{MICROSOFT_FILES_ROOT_DRIVE_ID:"drive"},{MICROSOFT_FILES_ROOT_FOLDER_ID:"folder"},{MICROSOFT_FILES_ROOT_DRIVE_ID:"bad drive",MICROSOFT_FILES_ROOT_FOLDER_ID:"folder"}])expect(()=>getMicrosoftFilesApprovedRoot(env)).toThrow(/configured correctly/);
  });
  it("walks only returned child folders, exposes names and never needs global drive/site discovery",async()=>{
    const provider=graph();provider.folders.mockResolvedValueOnce({folders:[folder("child")],complete:true}).mockResolvedValueOnce({folders:[folder("grandchild","child")],complete:true});
    const result=await browseApprovedMicrosoftFolders(provider,root,["child"],"files-app");
    expect(result.breadcrumbs.map(f=>f.id)).toEqual(["root","child"]);expect(result.folders.map(f=>f.id)).toEqual(["grandchild"]);
    expect(provider.target).toHaveBeenCalledExactlyOnceWith(root.driveId,"root","files-app");expect(provider.folders.mock.calls).toEqual([[root.driveId,"root"],[root.driveId,"child"]]);expect(provider.item).not.toHaveBeenCalled();
  });
  it("refuses arbitrary IDs and incomplete absence without fetching the requested out-of-root item",async()=>{
    const provider=graph();await expect(browseApprovedMicrosoftFolders(provider,root,["outside"],"files-app")).rejects.toThrow(/no longer inside/);expect(provider.item).not.toHaveBeenCalled();
    provider.folders.mockResolvedValue({folders:[],complete:false});await expect(browseApprovedMicrosoftFolders(provider,root,["outside"],"files-app")).rejects.toThrow(/bounded folder/);expect(provider.item).not.toHaveBeenCalled();
    await expect(browseApprovedMicrosoftFolders(provider,root,Array(21).fill("x"),"files-app")).rejects.toMatchObject({status:400});
    await expect(browseApprovedMicrosoftFolders(provider,root,["same","same"],"files-app")).rejects.toMatchObject({status:400});
  });
  it("rechecks the configured root and the stored target's bounded ancestry before any copy",async()=>{
    const provider=graph();provider.item.mockImplementation(async(_drive,id)=>folder(id,id==="leaf"?"child":"root"));
    await expect(assertMicrosoftFolderUnderRoot(provider,root,root.driveId,"leaf","files-app")).resolves.toBeUndefined();
    expect(provider.item.mock.calls).toEqual([[root.driveId,"leaf"],[root.driveId,"child"]]);
    provider.item.mockResolvedValue(folder("leaf","leaf"));await expect(assertMicrosoftFolderUnderRoot(provider,root,root.driveId,"leaf","files-app")).rejects.toThrow(/moved outside/);
    provider.item.mockResolvedValue({...folder("leaf"),remoteItem:{}});await expect(assertMicrosoftFolderUnderRoot(provider,root,root.driveId,"leaf","files-app")).rejects.toThrow(/moved outside/);
    await expect(assertMicrosoftFolderUnderRoot(provider,root,"other-drive","leaf","files-app")).rejects.toThrow(/outside.*drive/);
  });
});
