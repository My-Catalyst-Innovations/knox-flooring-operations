import { expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({}));
import { summarizeStagnantInventory } from "./stagnant-inventory";

it("values rolling stagnant inventory from receipt costs, estimates, and explicit gaps", () => {
  const now = new Date("2026-11-20T18:00:00Z");
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 86_400_000).toISOString();
  const stock = {
    sku: "FAKE-1",
    name: "Synthetic flooring",
    unit: "box",
    active: true,
  };
  const result = summarizeStagnantInventory(
    [
      { ...stock, id: "mixed", onHand: 13, catalogCost: 2 },
      { ...stock, id: "partial", onHand: 5, catalogCost: 0 },
      { ...stock, id: "active", onHand: 2, catalogCost: 33 },
    ],
    [
      {
        productId: "mixed",
        warehouseId: "office",
        warehouseName: "Office",
        onHand: 10,
        lastMovement: daysAgo(100),
      },
      {
        productId: "partial",
        warehouseId: "remote",
        warehouseName: "Remote",
        onHand: 5,
        lastMovement: daysAgo(30),
      },
      {
        productId: "active",
        warehouseId: "office",
        warehouseName: "Office",
        onHand: 2,
        lastMovement: daysAgo(15),
      },
    ],
    [
      {
        productId: "mixed",
        warehouseId: "office",
        trackedQuantity: 6,
        trackedValue: 30,
        receiptValue: 20,
      },
      {
        productId: "partial",
        warehouseId: "remote",
        trackedQuantity: 1,
        trackedValue: 2,
        receiptValue: 2,
      },
    ],
    now,
  );
  expect(result).toMatchObject({
    asOfDate: "2026-11-20",
    unknownMovementLocations: 1,
    windows: [
      {
        days: 30,
        locations: 2,
        receiptValue: 22,
        estimatedValue: 18,
        unvaluedLocations: 1,
      },
      {
        days: 60,
        locations: 1,
        receiptValue: 20,
        estimatedValue: 18,
        unvaluedLocations: 0,
      },
      {
        days: 90,
        locations: 1,
        receiptValue: 20,
        estimatedValue: 18,
        unvaluedLocations: 0,
      },
    ],
  });
  expect(result.records).toMatchObject([
    {
      productId: "mixed",
      warehouseId: "office",
      onHand: 10,
      inactiveDays: 100,
      receiptValue: 20,
      estimatedValue: 18,
      incompleteValue: false,
    },
    {
      productId: "partial",
      warehouseId: "remote",
      onHand: 5,
      inactiveDays: 30,
      receiptValue: 2,
      estimatedValue: 0,
      incompleteValue: true,
    },
  ]);
  for (const window of result.windows) {
    const sources = result.records.filter(
      ({ inactiveDays }) => inactiveDays >= window.days,
    );
    expect(sources).toHaveLength(window.locations);
    expect(
      sources.reduce(
        (sum, row) => sum + row.receiptValue + row.estimatedValue,
        0,
      ),
    ).toBeCloseTo(window.receiptValue + window.estimatedValue, 2);
    expect(
      sources.filter(({ incompleteValue }) => incompleteValue),
    ).toHaveLength(window.unvaluedLocations);
  }
});
