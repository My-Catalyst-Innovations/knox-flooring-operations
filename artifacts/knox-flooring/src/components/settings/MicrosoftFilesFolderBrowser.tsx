import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { operation } from "@/lib/operations";
import { microsoftFileUrl } from "@/lib/microsoft-file-links";

interface Folder {
  id: string;
  name: string;
  webUrl: string | null;
}
interface FolderPage {
  root: Folder & { driveId: string; key: string };
  current: Folder;
  breadcrumbs: Folder[];
  folders: Folder[];
  complete: boolean;
}

export function MicrosoftFilesFolderBrowser({
  disabled = false,
  targetLocked = false,
  onSelected,
}: {
  disabled?: boolean;
  targetLocked?: boolean;
  onSelected: () => Promise<unknown>;
}) {
  const [page, setPage] = useState<FolderPage | null>(null),
    [path, setPath] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false);
  async function browse(nextPath: string[]) {
    if (disabled || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setPage(null);
    try {
      const result = await operation<FolderPage>(
        `/microsoft/files/folders?${new URLSearchParams({ path: JSON.stringify(nextPath) })}`,
      );
      setPath(nextPath);
      setPage(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The approved folder could not be opened.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function choose() {
    if (!page || disabled || targetLocked || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await operation("/microsoft/files/target", "PUT", {
        folderPath: path,
        rootKey: page.root.key,
      });
      await onSelected();
      setPage(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The selected folder could not be verified.",
      );
      setPage(null);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const currentUrl = microsoftFileUrl(page?.current.webUrl);
  return (
    <section
      className="space-y-3"
      aria-label="Approved Microsoft folder browser"
    >
      <p className="text-muted-foreground">
        Browse only the company folder approved by your Microsoft administrator.
      </p>
      <Button
        variant="outline"
        disabled={disabled || busy}
        onClick={() => void browse([])}
      >
        {busy ? "Opening folder…" : "Browse approved company folder"}
      </Button>
      {targetLocked && (
        <p className="text-muted-foreground">
          Job folders already use this destination. Changing it requires a
          storage migration review.
        </p>
      )}
      {page && (
        <div className="space-y-3 rounded-md border p-3">
          <nav
            className="flex flex-wrap gap-2"
            aria-label="Microsoft folder path"
          >
            {page.breadcrumbs.map((folder, index) => (
              <Button
                key={folder.id}
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() => void browse(path.slice(0, index))}
              >
                {folder.name}
              </Button>
            ))}
          </nav>
          <p>
            Current folder: <strong>{page.current.name}</strong>
            {currentUrl && (
              <>
                {" "}
                ·{" "}
                <a
                  href={currentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Open in Microsoft
                </a>
              </>
            )}
          </p>
          {page.folders.length ? (
            <ul className="space-y-1">
              {page.folders.map((folder) => (
                <li key={folder.id}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || busy}
                    onClick={() => void browse([...path, folder.id])}
                  >
                    Open {folder.name}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              No subfolders are shown in this folder.
            </p>
          )}
          {!page.complete && (
            <p role="status">
              This folder is larger than the browsing limit. Shown folders can
              be selected; ask your administrator for a smaller approved folder
              if the destination is missing.
            </p>
          )}
          <Button
            disabled={disabled || busy || targetLocked}
            onClick={() => void choose()}
          >
            Use this folder for job files
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
