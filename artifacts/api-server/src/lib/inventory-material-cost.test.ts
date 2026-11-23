import { describe, expect, it } from "vitest";
import { priceJobMaterialUsage } from "./inventory-material-cost";

const stamp = "2026-11-23T12:00:00.000Z";
const layer = (quantity: number, unitCost: string) => ({
  layerId: "receipt:0", sourceMovementId: "receipt", quantity, unitCost,
  acquiredAt: stamp, source: "purchase_order" as const,
});

describe("job material allocation pricing", () => {
  it("uses receipt costs for waste without repricing it at the catalog rate", () => {
    const receipt = layer(3, "8.25");
    const priced = priceJobMaterialUsage({ cost: 99 }, "waste", 3, stamp, { slices: [receipt], untracked: 0 });
    expect(priced.cost).toBe(24.75);
    expect(priced.allocations).toEqual([receipt]);
  });
  it("snapshots only unpriced stock at the existing catalog fallback rate", () => {
    const priced = priceJobMaterialUsage({ cost: 10.01 }, "waste", 3, stamp, { slices: [layer(2, "0.335")], untracked: 1 });
    expect(priced.cost).toBe(10.68);
    expect(priced.allocations[0]).toMatchObject({ source: "catalog", sourceMovementId: "waste", quantity: 1, unitCost: "10.01" });
  });
  it("preserves cents on large allocations and rejects invalid unknown-stock rates", () => {
    expect(priceJobMaterialUsage({ cost: 0 }, "waste", 2, stamp, { slices: [layer(2, "262144.01")], untracked: 0 }).cost).toBe(524288.02);
    expect(() => priceJobMaterialUsage({ cost: NaN }, "waste", 1, stamp, { slices: [], untracked: 1 })).toThrow("valid catalog cost");
  });
});
