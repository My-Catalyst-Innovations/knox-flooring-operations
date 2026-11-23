import {
  MicrosoftFilesError,
  safeMicrosoftWebUrl,
  type MicrosoftDriveItem,
  type microsoftFilesGraph,
} from "./microsoft-files-graph";

type Graph = Pick<
  ReturnType<typeof microsoftFilesGraph>,
  "target" | "folders" | "item"
>;
export type ApprovedMicrosoftRoot = { driveId: string; folderId: string };
const folderDto = (item: MicrosoftDriveItem) => ({
  id: item.id,
  name: item.name,
  webUrl: safeMicrosoftWebUrl(item.webUrl),
});

/** Resolve caller-supplied navigation only by walking children of the approved
 * root. An arbitrary item ID is never fetched to satisfy a browsing request. */
export async function browseApprovedMicrosoftFolders(
  graph: Graph,
  root: ApprovedMicrosoftRoot,
  folderPath: readonly string[],
  clientId: string,
) {
  if (folderPath.length > 20 || new Set(folderPath).size !== folderPath.length)
    throw new MicrosoftFilesError(
      400,
      "Choose a folder within twenty levels of the approved company folder.",
    );
  const rootItem = await graph.target(root.driveId, root.folderId, clientId);
  let current = rootItem;
  const breadcrumbs = [folderDto(current)];
  for (const id of folderPath) {
    const children = await graph.folders(root.driveId, current.id);
    const candidate = children.folders.find((item) => item.id === id);
    if (!candidate)
      throw new MicrosoftFilesError(
        409,
        children.complete
          ? "This folder is no longer inside the approved company folder. Refresh the folder list."
          : "This folder could not be verified within the bounded folder list. Ask the administrator to choose a smaller approved root.",
      );
    current = candidate;
    breadcrumbs.push(folderDto(current));
  }
  const children = await graph.folders(root.driveId, current.id);
  return {
    root: { ...folderDto(rootItem), driveId: root.driveId },
    current: folderDto(current),
    breadcrumbs,
    folders: children.folders.map(folderDto),
    complete: children.complete,
  };
}

/** Re-check a previously approved stored destination before writing. This also
 * refuses a changed operator root, moved folders, cross-drive shortcuts/cycles. */
export async function assertMicrosoftFolderUnderRoot(
  graph: Graph,
  root: ApprovedMicrosoftRoot,
  driveId: string,
  folderId: string,
  clientId: string,
) {
  if (driveId !== root.driveId)
    throw new MicrosoftFilesError(
      409,
      "The stored Microsoft target is outside the approved company drive. Review the target in Settings.",
    );
  await graph.target(root.driveId, root.folderId, clientId);
  let id = folderId;
  const seen = new Set<string>();
  for (let depth = 0; depth <= 20; depth++) {
    if (id === root.folderId) return;
    if (seen.has(id)) break;
    seen.add(id);
    const item = await graph.item(driveId, id);
    if (
      item.id !== id ||
      !item.folder ||
      item.remoteItem ||
      item.parentReference?.driveId !== driveId ||
      !item.parentReference?.id
    )
      break;
    id = item.parentReference.id;
  }
  throw new MicrosoftFilesError(
    409,
    "The stored Microsoft folder moved outside the approved company folder. Review it before copying more files.",
  );
}
