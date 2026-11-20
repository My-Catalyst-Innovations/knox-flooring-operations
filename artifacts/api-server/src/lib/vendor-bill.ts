import { z } from "zod";
import { DomainError } from "./operations-rules";

export const vendorBillEntity = "vendor_bill";
const decimal = /^(?:\d{1,6}(?:\.\d{1,6})?|\.\d{1,6})$/;
const amount = /^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/;
const text = (length: number) => z.string().trim().min(1).max(length);
const line = z.object({
  supplierSku: text(200),
  unit: text(200),
  quantity: z
    .string()
    .regex(decimal)
    .refine((value) => Number(value) > 0),
  unitCost: z.string().regex(decimal),
});
export const vendorBillMode = z.enum(["review", "simulated", "sandbox"]);
export const vendorBillInput = z.object({
  mode: vendorBillMode,
  supplier: text(200),
  vendorId: z
    .string()
    .regex(/^\d{1,30}$/)
    .optional(),
  billNumber: z
    .string()
    .trim()
    .regex(/^[\w./-]{1,21}$/),
  billDate: z.string().date(),
  billTotal: z.string().regex(amount),
  lines: z.array(line).min(1).max(50),
});

export type VendorBillInput = z.infer<typeof vendorBillInput>;
interface SupplierBillLineMapping {
  supplierSku: string;
  productName: string;
  internalSku: string;
  unit: string;
  expectedUnitCost: string;
  priceEffectiveOn: string;
  priceSource: string;
}

export interface VendorBillLineMapping extends SupplierBillLineMapping {
  quickBooksItemId: string;
}

export function reviewVendorBill<Mapping extends SupplierBillLineMapping>(
  input: VendorBillInput,
  mappings: readonly Mapping[],
) {
  const lines = input.lines.map((requested, index) => {
    const mapping = mappings[index];
    if (
      !mapping ||
      mapping.unit.trim().toLowerCase() !== requested.unit.trim().toLowerCase()
    ) {
      throw new DomainError(
        409,
        `Review the approved purchase unit for ${requested.supplierSku}.`,
      );
    }
    const billedCost = scaled(requested.unitCost, 6);
    const expectedCost = scaled(mapping.expectedUnitCost, 6);
    const totalCents =
      (scaled(requested.quantity, 6) * billedCost + 5_000_000_000n) /
      10_000_000_000n;
    return {
      ...mapping,
      quantity: requested.quantity,
      billedUnitCost: requested.unitCost,
      totalCents: Number(totalCents),
      priceDiffers: billedCost !== expectedCost,
    };
  });
  const totalCents = lines.reduce((sum, item) => sum + item.totalCents, 0);
  if (totalCents <= 0 || totalCents !== Number(scaled(input.billTotal, 2))) {
    throw new DomainError(
      409,
      "The matched merchandise lines must equal the source bill total. Review units, quantities, and prices before approval.",
    );
  }
  return {
    supplier: input.supplier,
    totalCents,
    priceDiffers: lines.some((item) => item.priceDiffers),
    lines,
  };
}

export function buildVendorBill(
  input: VendorBillInput,
  mappings: VendorBillLineMapping[],
  vendorId: string,
) {
  const reviewed = reviewVendorBill(input, mappings);
  return {
    ...reviewed,
    quickBooksBill: {
      VendorRef: { value: vendorId },
      DocNumber: input.billNumber,
      TxnDate: input.billDate,
      Line: reviewed.lines.map((item) => ({
        Amount: item.totalCents / 100,
        DetailType: "ItemBasedExpenseLineDetail",
        Description: `${item.productName} (${item.supplierSku})`,
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: item.quickBooksItemId },
          Qty: Number(item.quantity),
          UnitPrice: Number(item.billedUnitCost),
        },
      })),
    },
  };
}

function scaled(decimal: string, places: number) {
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt((whole || "0") + fraction.padEnd(places, "0"));
}

type PreparedBill = ReturnType<typeof buildVendorBill>["quickBooksBill"];

export function matchesPostedBill(prepared: PreparedBill, posted: unknown) {
  const parsed = z
    .object({
      Id: z.string().regex(/^\d{1,30}$/),
      DocNumber: z.string(),
      TxnDate: z.string(),
      VendorRef: z.object({ value: z.string() }),
      TotalAmt: z.number(),
      Line: z.array(
        z.object({
          DetailType: z.string(),
          Amount: z.number().optional(),
          ItemBasedExpenseLineDetail: z
            .object({
              ItemRef: z.object({ value: z.string() }),
              Qty: z.number(),
              UnitPrice: z.number(),
            })
            .optional(),
        }),
      ),
    })
    .safeParse(posted);
  if (!parsed.success) return false;
  const bill = parsed.data;
  const itemLines = bill.Line.filter(
    (item) => item.DetailType === "ItemBasedExpenseLineDetail",
  );
  const totalCents = prepared.Line.reduce(
    (sum, item) => sum + Math.round(item.Amount * 100),
    0,
  );
  return (
    bill.DocNumber === prepared.DocNumber &&
    bill.TxnDate === prepared.TxnDate &&
    bill.VendorRef.value === prepared.VendorRef.value &&
    Math.round(bill.TotalAmt * 100) === totalCents &&
    itemLines.length === prepared.Line.length &&
    prepared.Line.every((expected, index) => {
      const actual = itemLines[index];
      const details = actual.ItemBasedExpenseLineDetail;
      return (
        Math.round((actual.Amount ?? NaN) * 100) ===
          Math.round(expected.Amount * 100) &&
        details?.ItemRef.value ===
          expected.ItemBasedExpenseLineDetail.ItemRef.value &&
        details.Qty === expected.ItemBasedExpenseLineDetail.Qty &&
        details.UnitPrice === expected.ItemBasedExpenseLineDetail.UnitPrice
      );
    })
  );
}

interface SandboxBillProvider {
  request(
    path: string,
    init?: RequestInit,
  ): Promise<{
    Vendor?: { Id: string; Active?: boolean; CurrencyRef?: { value?: string } };
    Preferences?: {
      CurrencyPrefs?: {
        HomeCurrency?: { value?: string };
        MultiCurrencyEnabled?: boolean;
      };
    };
    Item?: { Id: string; Active?: boolean; Type: string };
    Bill?: unknown;
  }>;
  query(statement: string): Promise<{ QueryResponse?: { Bill?: unknown[] } }>;
}

export async function reconcileSandboxBill(
  approved: PreparedBill,
  requestId: string,
  provider: SandboxBillProvider,
) {
  const vendorId = approved.VendorRef.value;
  const { Vendor: vendor } = await provider.request(`/vendor/${vendorId}`);
  if (vendor?.Id !== vendorId || vendor.Active === false)
    throw new Error("The approved QuickBooks sandbox vendor is unavailable.");
  const { Preferences: preferences } = await provider.request("/preferences");
  const currency = preferences?.CurrencyPrefs;
  if (
    currency?.HomeCurrency?.value !== "USD" ||
    (vendor.CurrencyRef && vendor.CurrencyRef.value !== "USD")
  )
    throw new Error(
      "This supplier bill pilot requires a QuickBooks sandbox and vendor that use USD.",
    );
  const { QueryResponse } = await provider.query(
    `select * from Bill where DocNumber = '${approved.DocNumber}' and VendorRef = '${vendorId}'`,
  );
  if (!QueryResponse)
    throw new Error(
      "QuickBooks did not return a bill reconciliation response.",
    );
  const existing = QueryResponse.Bill ?? [];
  if (existing.length) {
    if (existing.length !== 1 || !matchesPostedBill(approved, existing[0]))
      throw new Error(
        "A different QuickBooks sandbox bill already uses this vendor bill number. Review it in Intuit.",
      );
    const existingId = postedBillId(existing[0]);
    if (!existingId)
      throw new Error(
        "QuickBooks returned no bill ID. Check the sandbox before retrying.",
      );
    return { postedId: existingId, reconciledExisting: true };
  }
  for (const itemId of new Set(
    approved.Line.map((line) => line.ItemBasedExpenseLineDetail.ItemRef.value),
  )) {
    const { Item: item } = await provider.request(`/item/${itemId}`);
    if (
      item?.Id !== itemId ||
      item.Active === false ||
      !["Inventory", "NonInventory", "Service"].includes(item.Type)
    )
      throw new Error(
        `QuickBooks sandbox item ${itemId} cannot receive this bill.`,
      );
  }
  const document = currency.MultiCurrencyEnabled
    ? { ...approved, CurrencyRef: { value: "USD" } }
    : approved;
  const { Bill: created } = await provider.request(
    `/bill?requestid=${requestId}`,
    { method: "POST", body: JSON.stringify(document) },
  );
  const postedId = postedBillId(created);
  if (!postedId)
    throw new Error(
      "QuickBooks returned no bill ID. Check the sandbox before retrying.",
    );
  const { Bill: posted } = await provider.request(`/bill/${postedId}`);
  if (postedBillId(posted) !== postedId || !matchesPostedBill(approved, posted))
    throw new Error(
      `Sandbox bill ${postedId} was posted but its details differ. Review it in Intuit.`,
    );
  return { postedId, reconciledExisting: false };
}

function postedBillId(bill: unknown) {
  if (
    typeof bill !== "object" ||
    !bill ||
    !("Id" in bill) ||
    typeof bill.Id !== "string" ||
    !/^\d{1,30}$/.test(bill.Id)
  )
    return null;
  return bill.Id;
}
