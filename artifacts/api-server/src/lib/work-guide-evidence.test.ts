import { describe, expect, it } from "vitest";
import {
  installationGuide,
  operationalGuideRooms,
  operationalGuideScope,
  warehouseGuide,
} from "./work-guide-evidence";

it("exports only structured operational room facts and a neutral summary from legacy stored JSON", () => {
  const rooms = operationalGuideRooms([
    {
      id: "room-a",
      name: "Kitchen",
      length: 10,
      width: 12,
      scope: "Estimated price: $8.88",
      unitCost: 99,
      providerId: "private-provider",
      nested: { token: "private-token", margin: 0.4 },
    },
    null,
    { id: "room-b", name: { token: "private-token" }, length: 1, width: 2 },
    { id: "room-c", name: "Invalid", length: "10", width: 2 },
    {
      id: "room-d",
      name: "Invalid",
      length: Number.POSITIVE_INFINITY,
      width: 2,
    },
  ]);
  expect(rooms).toEqual([
    { id: "room-a", name: "Kitchen", length: 10, width: 12 },
  ]);
  expect(operationalGuideScope("Tile", rooms.length)).toBe(
    "Flooring: Tile. 1 recorded room(s). Confirm installation instructions with the office.",
  );
  expect(JSON.stringify(rooms)).not.toMatch(
    /Estimated price|unitCost|provider|token|margin|nested|scope/,
  );
  expect(operationalGuideRooms({ token: "not-an-array" })).toEqual([]);
});

function warehouse() {
  return {
    jobId: "job-a",
    order: { id: "order-a", warehouseId: "warehouse-a", status: "Received" },
    lines: [{ id: "line-a", productId: "product-a", quantity: "10.000000" }],
    receiptLines: [
      { lineId: "line-a", movementId: "receipt-a", quantity: "10.000000" },
    ],
    movements: [
      {
        id: "receipt-a",
        productId: "product-a",
        jobId: null,
        warehouseId: "warehouse-a",
        binId: "bin-a",
        kind: "receipt",
        quantity: 10,
      },
      {
        id: "issue-a",
        productId: "product-a",
        jobId: "job-a",
        warehouseId: "warehouse-a",
        binId: "bin-a",
        kind: "consume",
        quantity: -10,
      },
    ],
    bins: [{ id: "bin-a", warehouseId: "warehouse-a" }],
    reservations: [] as Parameters<typeof warehouseGuide>[0]["reservations"],
  };
}
const states = (input: Parameters<typeof warehouseGuide>[0]) =>
  warehouseGuide(input).map((step) => step.verified);

describe("saved warehouse outcomes", () => {
  it("verifies ordered lines from their accepted receipts, valid receiving bin and net issue", () => {
    expect(states(warehouse())).toEqual([true, true, true, true]);
    expect(states({ ...warehouse(), order: null })).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(
      states({
        ...warehouse(),
        order: { ...warehouse().order, status: "Cancelled" },
      }),
    ).toEqual([false, false, false, false]);
  });
  it("rejects shortage/damaged-only quantity, missing ledger evidence and mismatched line/product/location", () => {
    for (const patch of [
      {
        receiptLines: [
          { lineId: "line-a", movementId: "receipt-a", quantity: 0 },
        ],
      },
      {
        receiptLines: [
          { lineId: "other-line", movementId: "receipt-a", quantity: 10 },
        ],
      },
      { receiptLines: [{ lineId: "line-a", movementId: null, quantity: 10 }] },
      {
        movements: warehouse().movements.map((movement) => ({
          ...movement,
          warehouseId: "other-warehouse",
        })),
      },
      {
        movements: warehouse().movements.map((movement) => ({
          ...movement,
          productId: "other-product",
        })),
      },
      {
        receiptLines: [
          { lineId: "line-a", movementId: "receipt-a", quantity: 9 },
        ],
        movements: [{ ...warehouse().movements[0], quantity: 9 }],
      },
    ])
      expect(states({ ...warehouse(), ...patch })).toEqual([
        true,
        false,
        false,
        false,
      ]);
  });
  it("keeps saved named-bin staging evidence after issue, without counting released or unrelated reservations", () => {
    const input = warehouse();
    input.movements[0].binId = "";
    expect(states(input)).toEqual([true, true, false, true]);
    const staged = {
      productId: "product-a",
      jobId: "job-a",
      warehouseId: "warehouse-a",
      stagedBinId: "bin-a",
      status: "Active",
      quantity: 10,
    };
    expect(states({ ...input, reservations: [staged] })).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      states({ ...input, reservations: [{ ...staged, status: "Consumed" }] }),
    ).toEqual([true, true, true, true]);
    for (const patch of [
      { status: "Released" },
      { jobId: "other-job" },
      { warehouseId: "other-warehouse" },
      { quantity: 9 },
      { stagedBinId: null },
    ])
      expect(
        states({ ...input, reservations: [{ ...staged, ...patch }] })[2],
      ).toBe(false);
    expect(
      states({
        ...warehouse(),
        bins: [{ id: "bin-a", warehouseId: "other-warehouse" }],
      })[2],
    ).toBe(false);
  });
  it("returns can reopen the issue outcome and other jobs/warehouses/invalid signs never supply evidence", () => {
    const input = warehouse();
    expect(
      states({
        ...input,
        movements: [
          ...input.movements,
          {
            ...input.movements[1],
            id: "return-a",
            kind: "return",
            quantity: 1,
            returnOfMovementId: "issue-a",
          },
        ],
      })[3],
    ).toBe(false);
    expect(
      states({
        ...input,
        movements: [
          ...input.movements,
          {
            ...input.movements[1],
            id: "remote-return",
            kind: "return",
            warehouseId: "other-warehouse",
            quantity: 1,
            returnOfMovementId: "issue-a",
          },
        ],
      })[3],
    ).toBe(false);
    expect(
      states({
        ...input,
        movements: [
          ...input.movements,
          {
            ...input.movements[1],
            id: "unknown-origin-return",
            kind: "return",
            quantity: 1,
            returnOfMovementId: null,
          },
        ],
      })[3],
    ).toBe(false);
    for (const patch of [
      { jobId: "other-job" },
      { warehouseId: "other-warehouse" },
      { quantity: 10 },
      { kind: "return", quantity: -10 },
    ])
      expect(
        states({
          ...input,
          movements: [input.movements[0], { ...input.movements[1], ...patch }],
        })[3],
      ).toBe(false);
  });
});

describe("saved installation outcomes", () => {
  const input = {
    jobId: "job-a",
    installer: true,
    assignedTasks: 1,
    confirmedBookings: 1,
    ownUpdates: 1,
    finalPhotos: 1,
    recordedHours: 2,
    status: "Completed",
    completedAt: "2026-11-23T16:00:00Z",
    completionChecklist: { walkthrough: true },
    requiredChecks: ["walkthrough"],
  };
  it("separates personal updates from shared team evidence and provides no unsafe installer job-action links", () => {
    const guide = installationGuide(input);
    expect(guide.every((step) => step.verified)).toBe(true);
    expect(guide.filter((step) => step.href).map((step) => step.href)).toEqual([
      "/jobs/job-a/work-order",
    ]);
    expect(installationGuide({ ...input, ownUpdates: 0 })[1].verified).toBe(
      false,
    );
    expect(installationGuide({ ...input, assignedTasks: 0 })[0].verified).toBe(
      false,
    );
    expect(installationGuide({ ...input, recordedHours: 0 })[3].verified).toBe(
      false,
    );
  });
  it("does not accept stage-only closeout, owner override, missing company policy, or reopened work", () => {
    for (const patch of [
      { status: "In Progress" },
      { completedAt: null },
      { completedAt: "invalid" },
      { completionChecklist: {} },
      { requiredChecks: [] },
    ])
      expect(installationGuide({ ...input, ...patch })[4].verified).toBe(false);
    expect(
      installationGuide({ ...input, status: "Invoiced" })[4].verified,
    ).toBe(true);
    expect(
      installationGuide({ ...input, installer: false }).filter(
        (step) => step.href === "/jobs/job-a",
      ),
    ).toHaveLength(3);
  });
});
