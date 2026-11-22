import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { OperationsReportMetrics } from "./OperationsReportMetrics";

it("shows statement aging, the three ledger windows, and unknown completion data", () => {
  const counts = {
    movements: 4,
    receipts: 1,
    issued: 2,
    returns: 0,
    transfers: 1,
    binMoves: 0,
    adjustments: 0,
    other: 0,
  };
  render(
    <OperationsReportMetrics
      metrics={{
        asOfDate: "2026-11-20",
        invoiceAging: [
          { band: "pastDue31To60", invoiceCount: 2, balance: 420.12 },
          { band: "unknown", invoiceCount: 1, balance: 95 },
        ],
        inventoryActivity: [30, 60, 90].map((days) => ({ days, ...counts })),
        completionTimeliness: {
          committed: { onTime: 3, late: 1 },
          estimated: { onTime: 0, late: 0 },
          unknown: 2,
        },
        missingCompletionDates: 1,
        installationReadiness: {
          through: "2026-12-03",
          ready: 1,
          materialsNeedAttention: 2,
          needsCrew: 3,
        },
        sourceRecords: {
          invoices: [
            {
              invoiceId: "invoice one",
              invoiceNumber: "INV-1",
              customerName: "Test invoice customer",
              band: "pastDue31To60",
              balance: 75,
              dueDate: "2026-10-01",
            },
          ],
          completions: [
            {
              jobId: "completed one",
              jobNumber: "J-COMP",
              customerName: "Test completion customer",
              completedOn: "2026-11-16",
              targetOn: "2026-11-15",
              basis: "committed",
              outcome: "late",
            },
          ],
          installations: [
            {
              jobId: "upcoming one",
              jobNumber: "J-UP",
              customerName: "Test upcoming customer",
              scheduledOn: "2026-12-02",
              status: "materialsNeedAttention",
              issues: ["Synthetic cartons missing"],
            },
          ],
          postedCounts: [
            {
              id: "count one",
              sku: "COUNT-1",
              productName: "Counted tile",
              warehouseId: "test warehouse",
              warehouseName: "Test warehouse",
              binCode: "A1",
              postedAt: "2026-11-19T10:00:00.000Z",
              bookedQuantity: 2,
              countedQuantity: 1,
              unit: "box",
            },
          ],
        },
        stockAudit: {
          matched: 1,
          checked: 2,
          waste: [
            {
              productId: "test-product",
              sku: "WASTE-1",
              productName: "Demo tile",
              unit: "box",
              quantity: 1.5,
              entries: 1,
            },
          ],
          wasteByJob: [
            {
              jobId: "job-1",
              jobNumber: "J-1",
              crewId: "crew-1",
              crewName: "Crew One",
              unit: "box",
              entries: 1,
              quantity: 1.5,
            },
          ],
        },
      }}
    />,
  );
  const aging = screen.getByRole("table", {
    name: "Open invoices by due date",
  });
  expect(
    within(aging).getByRole("row", { name: /31–60 days overdue/ }),
  ).toHaveTextContent("$420.12");
  expect(
    within(aging).getByRole("row", { name: /due date unknown/i }),
  ).toHaveTextContent("$95.00");
  const inventory = screen.getByRole("table", {
    name: "Inventory movement entries by type and window",
  });
  expect(
    within(inventory)
      .getAllByRole("columnheader")
      .map((column) => column.textContent),
  ).toEqual(["Entry", "30d", "60d", "90d"]);
  expect(screen.getByText("75%")).toBeInTheDocument();
  expect(screen.getByText("No comparable records")).toBeInTheDocument();
  expect(
    screen.getByText("2 without a usable completion target"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/1 completed job has no recorded completion date/),
  ).toBeInTheDocument();
  expect(screen.getByText("50%")).toBeInTheDocument();
  expect(screen.getByText("Crew needs confirmation")).toBeInTheDocument();
  expect(
    within(
      screen.getByRole("table", { name: "Posted waste by product and unit" }),
    ).getByText("1.5 box"),
  ).toBeInTheDocument();
  expect(screen.getByText("Waste by job and crew")).toBeInTheDocument();
  for (const [label, href] of [
    ["View source invoices", "/invoices?invoice=invoice%20one"],
    ["View completed jobs", "/jobs/completed%20one"],
    ["View installation jobs", "/jobs/upcoming%20one"],
    [
      "View posted stock counts",
      "/inventory/bins?warehouse=test+warehouse&count=count+one",
    ],
  ]) {
    const details = screen.getByText(`${label} (1)`).closest("details")!;
    details.open = true;
    expect(within(details).getByRole("link")).toHaveAttribute("href", href);
  }
  expect(screen.getByText("Synthetic cartons missing")).toBeInTheDocument();
});
