/** Read-only saved outcomes, not a learner certificate or proof of personal work. */
export function operationalGuideRooms(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const room = item as Record<string, unknown>;
    if (
      typeof room.id !== "string" ||
      typeof room.name !== "string" ||
      typeof room.length !== "number" ||
      !Number.isFinite(room.length) ||
      typeof room.width !== "number" ||
      !Number.isFinite(room.width)
    )
      return [];
    // Stored JSON is not constrained by its TypeScript interface. In particular,
    // freeform scope may contain quote prices; export structured room facts only.
    return [
      { id: room.id, name: room.name, length: room.length, width: room.width },
    ];
  });
}
export const operationalGuideScope = (
  flooringType: string,
  roomCount: number,
) =>
  `Flooring: ${flooringType}. ${roomCount} recorded room(s). Confirm installation instructions with the office.`;

export interface GuideStep {
  key: string;
  title: string;
  instruction: string;
  verified: boolean;
  evidence: string;
  href?: string;
  actionLabel?: string;
}
type Line = { id: string; productId: string; quantity: string | number };
type Movement = {
  id: string;
  productId: string;
  jobId: string | null;
  warehouseId: string | null;
  binId: string | null;
  kind: string;
  quantity: number;
  returnOfMovementId?: string | null;
};
type ReceiptLine = {
  lineId: string;
  movementId: string | null;
  quantity: string | number;
};
const positive = (value: unknown) =>
  Number.isFinite(Number(value)) && Number(value) > 0;
const covers = (actual: number, expected: number) =>
  Number.isFinite(actual) &&
  Number.isFinite(expected) &&
  expected > 0 &&
  actual + 0.000001 >= expected;

export function warehouseGuide(input: {
  jobId: string;
  order: { id: string; warehouseId: string; status: string } | null;
  lines: Line[];
  receiptLines: ReceiptLine[];
  movements: Movement[];
  bins: { id: string; warehouseId: string }[];
  reservations: {
    productId: string;
    jobId: string;
    warehouseId: string | null;
    stagedBinId: string | null;
    status: string;
    quantity: number;
  }[];
}): GuideStep[] {
  const { order, lines } = input;
  const href = `/inventory/purchase-orders?job=${encodeURIComponent(input.jobId)}${order ? `&order=${encodeURIComponent(order.id)}` : ""}`;
  const active =
    !!order &&
    ["Ordered", "Partially received", "Received"].includes(order.status);
  const accepted = (line: Line) =>
    input.receiptLines
      .filter(
        (receipt) => receipt.lineId === line.id && positive(receipt.quantity),
      )
      .flatMap((receipt) => {
        const movement = input.movements.find(
          (item) =>
            item.id === receipt.movementId &&
            item.kind === "receipt" &&
            item.productId === line.productId &&
            item.warehouseId === order?.warehouseId &&
            Math.abs(item.quantity - Number(receipt.quantity)) <= 0.000001,
        );
        return movement
          ? [{ quantity: Number(receipt.quantity), binId: movement.binId }]
          : [];
      });
  const received =
    active &&
    lines.length > 0 &&
    lines.every((line) =>
      covers(
        accepted(line).reduce((sum, item) => sum + item.quantity, 0),
        Number(line.quantity),
      ),
    );
  const namedBin = (binId: string | null) =>
    !!binId &&
    input.bins.some(
      (bin) => bin.id === binId && bin.warehouseId === order?.warehouseId,
    );
  const binned =
    received &&
    lines.every((line) => {
      const receivedInBins = accepted(line)
        .filter((item) => namedBin(item.binId))
        .reduce((sum, item) => sum + item.quantity, 0);
      const staged = input.reservations
        .filter(
          (item) =>
            item.productId === line.productId &&
            item.jobId === input.jobId &&
            item.warehouseId === order?.warehouseId &&
            ["Active", "Consumed"].includes(item.status) &&
            namedBin(item.stagedBinId),
        )
        .reduce((sum, item) => sum + item.quantity, 0);
      return covers(Math.max(receivedInBins, staged), Number(line.quantity));
    });
  const issued =
    received &&
    lines.every((line) => {
      const issues = input.movements.filter(
        (item) =>
          item.productId === line.productId &&
          item.jobId === input.jobId &&
          item.warehouseId === order?.warehouseId &&
          Number.isFinite(item.quantity) &&
          item.kind === "consume" &&
          item.quantity < 0,
      );
      const returns = input.movements.filter(
        (item) =>
          item.kind === "return" &&
          item.productId === line.productId &&
          item.jobId === input.jobId &&
          Number.isFinite(item.quantity) &&
          item.quantity > 0,
      );
      // Return destination may differ from the issue warehouse. Only its immutable
      // issue reference proves which warehouse's issue is being reversed.
      if (returns.some((item) => !item.returnOfMovementId)) return false;
      const issueIds = new Set(issues.map((item) => item.id));
      const net =
        issues.reduce((sum, item) => sum - item.quantity, 0) -
        returns
          .filter((item) => issueIds.has(item.returnOfMovementId!))
          .reduce((sum, item) => sum + item.quantity, 0);
      return covers(net, Number(line.quantity));
    });
  return [
    {
      key: "ordered",
      title: "Confirm the linked purchase order",
      instruction:
        "Select the real job's purchase order. Verify supplier, products, units, warehouse and quantities before marking it ordered.",
      verified: active,
      evidence: active
        ? "An ordered, non-cancelled purchase order is saved for this job."
        : "Choose a linked order that has been marked ordered.",
      href,
      actionLabel: "Open purchase orders",
    },
    {
      key: "received",
      title: "Receive usable stock",
      instruction:
        "Record actual accepted and damaged quantities. Damaged units do not satisfy usable receipt evidence.",
      verified: received,
      evidence: received
        ? "Saved accepted receipt lines and matching warehouse receipt movements cover every ordered line."
        : "Every ordered line needs accepted quantities backed by its saved warehouse receipt movement.",
      href,
      actionLabel: "Review receiving",
    },
    {
      key: "binned",
      title: "Record the receiving or staging bin",
      instruction:
        "Receive each product into a named bin, or stage its full ordered quantity for this job in a named bin at the same warehouse. Saved consumed staging allocations also count. A later move alone does not prove receipt allocation.",
      verified: binned,
      evidence: binned
        ? "Each line has enough accepted receipt quantity in named bins, or active/consumed named-bin job staging reservations."
        : "Named receipt bins or saved active/consumed job staging quantities must cover every ordered line.",
      href: `/inventory/bins${order ? `?warehouse=${encodeURIComponent(order.warehouseId)}` : ""}`,
      actionLabel: "Open warehouse bins",
    },
    {
      key: "issued",
      title: "Issue stock to the job",
      instruction:
        "Use the job's stock actions to record the actual issue from this warehouse. Returns reduce the net issued quantity. Confirm quantities before posting.",
      verified: issued,
      evidence: issued
        ? "Saved net stock issues to this job from the selected warehouse cover the order quantities."
        : "Net consume/return ledger quantities for this job and warehouse do not yet cover every order line.",
      href: `/jobs/${encodeURIComponent(input.jobId)}`,
      actionLabel: "Open job stock actions",
    },
  ];
}

export function installationGuide(input: {
  jobId: string;
  installer: boolean;
  assignedTasks: number;
  confirmedBookings: number;
  ownUpdates: number;
  finalPhotos: number;
  recordedHours: number;
  status: string;
  completedAt: string | null;
  completionChecklist: Record<string, boolean>;
  requiredChecks: string[];
}): GuideStep[] {
  const href = `/jobs/${encodeURIComponent(input.jobId)}`;
  const closeout =
    ["Completed", "Invoiced"].includes(input.status) &&
    !!input.completedAt &&
    Number.isFinite(Date.parse(input.completedAt)) &&
    input.requiredChecks.length > 0 &&
    input.requiredChecks.every(
      (key) => input.completionChecklist[key] === true,
    );
  const managedAction = input.installer
    ? {}
    : { href, actionLabel: "Open installation and closeout" };
  return [
    {
      key: "assignment",
      title: "Review the assigned work",
      instruction:
        "Check the work order, scope, location and dates. Only an explicit task assignment grants installer guide access; a crew name alone does not.",
      verified: input.installer
        ? input.assignedTasks > 0
        : input.confirmedBookings > 0,
      evidence: input.installer
        ? `${input.assignedTasks} non-cancelled task assignment(s) saved for you on this job.`
        : `${input.confirmedBookings} confirmed crew booking(s) saved.`,
      href: `${href}/work-order`,
      actionLabel: "Open safe work order",
    },
    {
      key: "update",
      title: "Save a field update",
      instruction:
        "Use the update form below to record work performed, an issue, or a handoff. Do not mark anything complete until the real work is saved.",
      verified: input.ownUpdates > 0,
      evidence:
        input.ownUpdates > 0
          ? `${input.ownUpdates} update(s) saved by your signed-in account on this job.`
          : "No job update from your signed-in account is saved yet.",
    },
    {
      key: "photos",
      title: "Save final installation photos",
      instruction: input.installer
        ? "Have operations save the real final walkthrough or completed-stage photos on this job. This step verifies saved team evidence, not who took the photo."
        : "Save the actual final walkthrough or completed-stage photos on this job.",
      verified: input.finalPhotos > 0,
      evidence: `${input.finalPhotos} final walkthrough/completed-stage photo record(s) saved for this job.`,
      ...managedAction,
    },
    {
      key: "time",
      title: "Record performed labor",
      instruction: input.installer
        ? "Ask operations to record the actual hours against the assigned installation booking. Saved team hours are not proof of your individual hours or payroll."
        : "Record actual performed hours, with the correct job and confirmed crew booking. These are team records, not payroll.",
      verified: input.recordedHours > 0,
      evidence: `${input.recordedHours} hour(s) saved against the authorized confirmed booking(s).`,
      ...managedAction,
    },
    {
      key: "closeout",
      title: "Verify the saved closeout",
      instruction: input.installer
        ? "Operations or the owner must review the required checks and complete the job. Opening this guide never changes the job's stage."
        : "Review company-required checks, resolve issues, then complete the job through its normal workflow. An owner override alone does not satisfy this guide.",
      verified: closeout,
      evidence: closeout
        ? "The job has a saved completion date, completed/invoiced stage, and every configured required closeout check."
        : input.requiredChecks.length
          ? "Saved completion date, completed stage and all required closeout checks are still needed."
          : "The owner must configure required closeout checks before this outcome can be verified.",
      ...managedAction,
    },
  ];
}
