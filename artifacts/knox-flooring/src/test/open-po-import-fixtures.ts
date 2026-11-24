import type {
  OpenPoDecision,
  OpenPoImportBatch,
  OpenPoSourceOrder,
} from "@workspace/domain";
export const importSupplier = {
  id: "supplier-a",
  name: "Reviewed supplier",
  revision: 2,
  active: true,
};
export const importWarehouse = {
  id: "warehouse-a",
  name: "Office warehouse",
  updatedAt: "2026-11-23T14:00:00Z",
};
export const importProduct = {
  id: "product-a",
  name: "Selected stock product",
  sku: "000012",
  unit: "sq ft",
  revision: 3,
  active: true,
  inventoryType: "Inventory",
  updatedAt: "2026-11-23T14:00:00Z",
};
export const importSource: OpenPoSourceOrder = {
  sourcePoId: "00001",
  errors: [],
  lines: [
    {
      line: 2,
      sourcePoId: "00001",
      sourcePoNumber: "000078",
      sourceLineId: "000001",
      sourceStatus: "Partially received",
      supplierRef: "Original supplier ref",
      warehouseRef: "Original office ref",
      jobRef: "",
      productRef: "000012",
      unit: "sq ft",
      orderedQty: "12.300001",
      receivedQty: "2.1",
      cancelledQty: "0.2",
      outstandingQty: "10.000001",
      unitCost: "4.460001",
      currency: "USD",
      expectedOn: "2026-12-01",
    },
  ],
};
export const importDecision: OpenPoDecision = {
  sourcePoId: importSource.sourcePoId,
  action: "create",
  note: "Owner reviewed source order remains open",
  supplierId: importSupplier.id,
  supplierRevision: importSupplier.revision,
  warehouseId: importWarehouse.id,
  warehouseUpdatedAt: importWarehouse.updatedAt,
  jobId: null,
  sourceOpenConfirmed: true,
  outstandingOnlyConfirmed: true,
  lines: [
    {
      line: 2,
      action: "include",
      productId: importProduct.id,
      productRevision: importProduct.revision,
      note: "",
    },
  ],
};
export function openPoBatch(
  status: OpenPoImportBatch["status"] = "preview",
): OpenPoImportBatch {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sourceSystem: "legacy-test",
    batchKey: "open-orders-2026",
    fileName: "Original orders.csv",
    sourceSha256: "a".repeat(64),
    sourceSnapshotAt: "2026-11-23T14:00:00-05:00",
    cutoverAt: "2026-11-23T15:00:00-05:00",
    rows: [{ ...structuredClone(importSource), imported: null }],
    status,
    revision: status === "preview" ? 1 : status === "reviewed" ? 2 : 3,
    previewFingerprint: "b".repeat(64),
    reviewFingerprint: status === "preview" ? null : "c".repeat(64),
    reviewed:
      status === "preview"
        ? []
        : [
            {
              decision: structuredClone(importDecision),
              selected: {
                supplier: importSupplier,
                warehouse: importWarehouse,
                job: null,
                existingOrder: null,
                lines: [
                  {
                    source: importSource.lines[0],
                    choice: importDecision.lines![0],
                    product: importProduct,
                  },
                ],
              },
            },
          ],
    reviewNote:
      status === "preview"
        ? null
        : "Reviewed actual source and linked operational records",
    approval:
      status === "approved" || status === "committed"
        ? {
            id: "22222222-2222-4222-8222-222222222222",
            fingerprint: "c".repeat(64),
            approvedBy: "owner-a",
            approvedAt: "2026-11-23T21:00:00Z",
          }
        : null,
    result: null,
  };
}
