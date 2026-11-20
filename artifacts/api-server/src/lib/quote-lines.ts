import { randomUUID } from "node:crypto";
import {
  invoiceLineAmount,
  invoiceSubtotal,
  type EstimateSnapshot,
} from "@workspace/domain";
import type { InvoiceLineItem, ProposalLineItem, ProposalRow } from "@workspace/db";

/** Allocate the reviewed selling price in whole cents, without exposing internal costs. */
export function sellingQuoteLines(
  snapshot: EstimateSnapshot,
): ProposalLineItem[] {
  const parts = [
    ...snapshot.lines
      .filter((line) => (line.quantity ?? 0) > 0)
      .map((line) => ({
        name: line.name,
        productId: line.productId,
        sku: line.sku,
        unit: line.unit,
        quantity: line.quantity!,
        cost: line.totalCost,
        category: "Materials",
      })),
    ...(snapshot.rawSqFt > 0
      ? [
          {
            name: `${snapshot.inputs.flooringType} installation labor`,
            productId: undefined,
            sku: undefined,
            unit: "sqft",
            quantity: snapshot.rawSqFt,
            cost: snapshot.laborCost,
            category: "Installation",
          },
        ]
      : []),
    ...snapshot.inputs.allowances
      .filter((a) => a.cost > 0)
      .map((a) => ({
        name: a.name,
        productId: undefined,
        sku: undefined,
        unit: "each",
        quantity: 1,
        cost: Math.round(a.cost * 100) / 100,
        category: "Add-on",
      })),
  ];
  const target = Math.round(snapshot.sellingPrice * 100);
  const totalWeight = parts.reduce(
    (sum, p) => sum + Math.round(p.cost * 100),
    0,
  );
  const allocations = parts.map((p, index) => {
    const exact =
      totalWeight > 0 ? (target * Math.round(p.cost * 100)) / totalWeight : 0;
    return {
      index,
      cents: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  const left = target - allocations.reduce((sum, a) => sum + a.cents, 0);
  const ranking = [...allocations].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (let i = 0; i < left && ranking.length; i++)
    ranking[i % ranking.length].cents++;
  return parts.map((part, index) => ({
    id: randomUUID(),
    name: part.name,
    productId: part.productId,
    sku: part.sku,
    unit: part.unit,
    quantity: part.quantity,
    unitPrice: allocations[index].cents / 100 / part.quantity,
    lineTotal: allocations[index].cents / 100,
    category: part.category,
  }));
}

export function acceptedQuoteInvoice(
  proposal: Pick<
    ProposalRow,
    "lineItems" | "estimatedPrice" | "scopeOfWork" | "flooringType"
  >,
) {
  const total = Math.round(proposal.estimatedPrice * 100) / 100;
  const lineItems: InvoiceLineItem[] = proposal.lineItems
    .filter((line) => line.quantity > 0)
    .map((line) => {
      const category = line.category?.trim().toLowerCase();
      const unit = line.unit?.trim();
      // Older quotes can store a displayed line amount separate from their unit price.
      const unitPrice =
        typeof line.lineTotal === "number" &&
        invoiceLineAmount(line) !== Math.round(line.lineTotal * 100) / 100
          ? line.lineTotal / line.quantity
          : line.unitPrice;
      return {
        id: randomUUID(),
        description: unit ? `${line.name} (${unit})` : line.name,
        category:
          category === "installation" || category === "labor"
            ? "Labor"
            : category === "add-on"
              ? "Add-on"
              : "Materials",
        quantity: line.quantity,
        unitPrice,
        ...(line.productId ? { productId: line.productId } : {}),
        ...(line.sku ? { sku: line.sku } : {}),
      };
    });
  if (!lineItems.length) {
    lineItems.push({
      id: randomUUID(),
      description:
        proposal.scopeOfWork || `${proposal.flooringType} installation`,
      category: "Materials",
      quantity: 1,
      unitPrice: total,
    });
  }

  // Legacy quotes may itemize materials while the accepted price also covers other work.
  const remainder = Math.round((total - invoiceSubtotal(lineItems)) * 100) / 100;
  if (remainder > 0) {
    lineItems.push({
      id: randomUUID(),
      description: "Remaining quoted scope",
      category: "Add-on",
      quantity: 1,
      unitPrice: remainder,
    });
  }
  return {
    lineItems,
    subtotal: invoiceSubtotal(lineItems),
    discountAmount: Math.max(0, -remainder),
    taxableAmount: total,
    total,
    balanceAmount: total,
  };
}
