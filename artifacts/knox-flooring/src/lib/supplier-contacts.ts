import {
  supplierImportMaxBytes,
  type SupplierContact,
} from "@workspace/domain";
export type SupplierList = {
  suppliers: SupplierContact[];
  page: number;
  hasMore: boolean;
};
export interface SupplierDetail {
  supplier: SupplierContact;
  provenance: {
    record: {
      id: string;
      sourceSystem: string;
      sourceId: string;
      sourceLine: number;
      action: "create" | "link";
      sourceData: Record<string, string>;
      supplierSnapshot: Record<string, unknown>;
      createdAt: string;
    };
    batch: {
      id: string;
      fileName: string;
      sourceSha256: string;
      committedAt: string | null;
    };
    approval: {
      id: string;
      fingerprint: string;
      approvedBy: string;
      approvedAt: string;
      reviewNote: string;
    };
  }[];
}
export async function readSupplierCsv(file: File) {
  if (!file.size || file.size > supplierImportMaxBytes)
    throw new Error("Choose a CSV or TSV up to 1 MiB.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    throw new Error(
      "Export supplier contacts as UTF-8 CSV or TSV before importing.",
    );
  }
}
