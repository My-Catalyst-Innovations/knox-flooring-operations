import type {
  LegacyArchiveBatch,
  LegacyArchiveRecord,
} from "@workspace/domain";
import type { LegacyArchiveDetail } from "@/lib/legacy-history";
export const archiveBatch: LegacyArchiveBatch = {
  id: "batch-a",
  sourceSystem: "legacy-test",
  batchKey: "original-2020",
  fileName: "Original history.csv",
  sourceSha256: "a".repeat(64),
  rows: [
    {
      line: 2,
      data: {
        sourceId: "00001",
        recordType: "invoice",
        title: "Historical invoice",
        reference: "INV-00001",
        partyName: "Historical party",
        occurredOn: null,
        status: "Paid in source",
        summary: "Source amount $123.45; historical evidence only.",
      },
      errors: [],
      fileDuplicates: [],
      existing: null,
    },
  ],
  status: "preview",
  revision: 1,
  previewFingerprint: "b".repeat(64),
  reviewFingerprint: null,
  decisions: [],
  reviewNote: null,
  approval: null,
  result: null,
};
export const archiveRecord: LegacyArchiveRecord = {
  ...archiveBatch.rows[0].data,
  id: "archive-a",
  batchId: "batch-a",
  approvalId: "approval-a",
  sourceSystem: archiveBatch.sourceSystem,
  sourceLine: 2,
  recordSha256: "c".repeat(64),
  createdAt: "2026-11-23T16:00:00Z",
};
export const archiveDetail: LegacyArchiveDetail = {
  record: archiveRecord,
  batch: {
    id: "batch-a",
    sourceSystem: archiveBatch.sourceSystem,
    batchKey: archiveBatch.batchKey,
    fileName: archiveBatch.fileName,
    sourceSha256: archiveBatch.sourceSha256,
    committedAt: "2026-11-23T16:00:00Z",
  },
  approval: {
    id: "approval-a",
    fingerprint: "d".repeat(64),
    approvedBy: "owner-a",
    approvedAt: "2026-11-23T15:00:00Z",
    reviewNote: "Reviewed historical evidence only",
  },
  documents: [
    {
      id: "doc-a",
      recordId: "archive-a",
      name: "Original.pdf",
      size: 120,
      sha256: "e".repeat(64),
      createdAt: "2026-11-23T17:00:00Z",
      downloadUrl: "/api/legacy-history/documents/doc-a/download",
    },
  ],
};
