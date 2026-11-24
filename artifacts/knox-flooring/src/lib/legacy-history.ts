import { customFetch } from "@workspace/api-client-react";
import {
  legacyArchiveMaxBytes,
  type LegacyArchiveRecord,
} from "@workspace/domain";

export interface LegacyArchiveDocument {
  id: string;
  recordId: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
}
export interface LegacyArchiveDetail {
  record: LegacyArchiveRecord;
  batch: {
    id: string;
    sourceSystem: string;
    batchKey: string;
    fileName: string;
    sourceSha256: string;
    committedAt: string;
  };
  approval: {
    id: string;
    fingerprint: string;
    approvedBy: string;
    approvedAt: string;
    reviewNote: string;
  };
  documents: LegacyArchiveDocument[];
}
export interface LegacyArchiveImportSummary {
  id: string;
  sourceSystem: string;
  batchKey: string;
  fileName: string;
  status: string;
  createdAt: string;
}
export const legacyOriginalMaxBytes = 15 * 1024 * 1024;
export const legacyOriginalTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
export const legacyArchiveLabels = {
  job: "Job",
  quote: "Quote",
  invoice: "Invoice",
  purchase_order: "Purchase order",
  payment: "Payment",
  other: "Other",
};
export function legacyArchiveLabel(value: string): string {
  return Object.hasOwn(legacyArchiveLabels, value)
    ? legacyArchiveLabels[value as keyof typeof legacyArchiveLabels]
    : value;
}

export function legacyDocumentDownload(
  document: Pick<LegacyArchiveDocument, "id" | "downloadUrl">,
) {
  const expected = `/api/legacy-history/documents/${encodeURIComponent(document.id)}/download`;
  return document.downloadUrl === expected ? expected : null;
}
export async function uploadLegacyOriginal(file: File, recordId: string) {
  if (
    !file.size ||
    file.size > legacyOriginalMaxBytes ||
    !legacyOriginalTypes.has(file.type)
  )
    throw new Error("Choose a PDF or supported image up to 15 MiB.");
  return customFetch<{ objectPath: string }>(
    `/api/storage/files/legacy-document?recordId=${encodeURIComponent(recordId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: file,
      responseType: "json",
    },
  );
}
export async function readLegacyCsv(file: File) {
  if (!file.size || file.size > legacyArchiveMaxBytes)
    throw new Error("Choose a CSV or TSV up to 1 MiB.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error(
      "Export the history file as UTF-8 CSV or TSV before importing it.",
    );
  }
}
