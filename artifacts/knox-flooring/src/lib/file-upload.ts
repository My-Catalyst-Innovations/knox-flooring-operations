import { useRef, useState } from "react";
import { customFetch } from "@workspace/api-client-react";

type FilePurpose = "job-photo" | "portal-photo" | "lead-document" | "job-document" | "product-image" | "company-logo";
export const supportedImageTypes = "image/jpeg,image/png,image/webp,image/gif";
const maxFileBytes = 15 * 1024 * 1024;

export function fileSrc(path: string): string {
  if (/^\/objects\/[a-z0-9/_-]+$/.test(path)) return `/api/storage${path}`;
  if (/^\/api\/public\/jobs\/[^/?#]+\/photos\/[^/?#]+$/.test(path)) return path;
  return "";
}

export function useStoredFileUpload(onError: (error: Error) => void) {
  const [isUploading, setIsUploading] = useState(false);
  const busy = useRef(false);

  async function uploadFile(file: File, purpose: FilePurpose, recordId: string | null, attach: (objectPath: string) => void | Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setIsUploading(true);
    try {
      if (!file.size || file.size > maxFileBytes) throw new Error("Choose a file up to 15 MB.");
      const query = recordId ? `?recordId=${encodeURIComponent(recordId)}` : "";
      const { objectPath } = await customFetch<{ objectPath: string }>(`/api/storage/files/${purpose}${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file,
        responseType: "json",
      });
      await attach(objectPath);
    } catch (error) {
      onError(error instanceof Error ? error : new Error("The file could not be saved."));
    } finally {
      busy.current = false;
      setIsUploading(false);
    }
  }

  return { uploadFile, isUploading };
}
