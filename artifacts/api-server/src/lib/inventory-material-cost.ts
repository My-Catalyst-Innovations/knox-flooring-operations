import type { InventoryCostSlice } from "@workspace/db";
import { allocatedIssueCents, allocatedIssueUnitCost } from "./inventory-issue-cost";
import { DomainError } from "./operations-rules";

/** One pricing policy for stock issued to a job and approved waste assigned to it. */
export function priceJobMaterialUsage(
  product: { cost: number },
  movementId: string,
  quantity: number,
  now: string,
  costs: { slices: readonly InventoryCostSlice[]; untracked: number },
) {
  const allocations = [...costs.slices];
  if (costs.untracked > 0) {
    if (!Number.isFinite(product.cost) || product.cost < 0) {
      throw new DomainError(409, "Set a valid catalog cost before assigning this product to a job.");
    }
    allocations.unshift({
      layerId: null, sourceMovementId: movementId, quantity: costs.untracked,
      unitCost: String(product.cost), acquiredAt: now, source: "catalog",
    });
  }
  const cents = allocatedIssueCents(allocations);
  if (!Number.isSafeInteger(cents)) {
    throw new DomainError(409, "This material charge exceeds the supported amount.");
  }
  return { allocations, cost: cents / 100, unitCost: allocatedIssueUnitCost(allocations, quantity) };
}
