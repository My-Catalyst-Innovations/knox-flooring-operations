import { workspaceEnvironment } from "@workspace/db/workspace";
import { z } from "zod";
import { convertedSupplierLine, supplierDecimalPattern } from "@workspace/domain";
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
const charge = z.object({
  kind: z.enum(["freight", "supplier_tax", "fee"]),
  description: text(200),
  accountId: z.string().regex(/^\d{1,30}$/).optional(),
  amount: z.string().regex(amount).refine((value) => Number(value) > 0),
}).strict();
export const vendorBillMode = z.enum([
  "review",
  "simulated",
  "sandbox",
  "production",
]);
export const vendorBillFingerprint = z.string().regex(/^[a-f\d]{64}$/);
const vendorBillFields = z.object({
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
  lines: z.array(line).max(50),
  charges: z.array(charge).max(20).optional(),
});
function hasBillLineCount(value: z.infer<typeof vendorBillFields>) {
  const count = value.lines.length + (value.charges?.length ?? 0);
  return count > 0 && count <= 50;
}
const lineCountError = { message: "Enter 1–50 merchandise and account charge lines in total.", path: ["lines"] };
export const vendorBillInput = vendorBillFields.refine(hasBillLineCount, lineCountError);
export const queuedVendorBillInput = vendorBillFields.extend({ fingerprint: vendorBillFingerprint }).refine(hasBillLineCount, lineCountError);

export type VendorBillInput = z.infer<typeof vendorBillInput>;

type ProductionBillConnection = {
  environment: string;
  status: string;
  realmId: string;
};

export function productionVendorBillsAvailable(
  connection: ProductionBillConnection | null,
  env: NodeJS.ProcessEnv = workspaceEnvironment(),
) {
  return (
    env.QUICKBOOKS_PRODUCTION_VENDOR_BILLS_ENABLED === "true" &&
    env.DEMO_MODE !== "true" &&
    env.QUICKBOOKS_ENVIRONMENT === "production" &&
    !!env.QUICKBOOKS_PRODUCTION_VENDOR_BILLS_REALM_ID &&
    connection?.status === "connected" &&
    connection.environment === "production" &&
    connection.realmId === env.QUICKBOOKS_PRODUCTION_VENDOR_BILLS_REALM_ID
  );
}

export function confirmProductionVendorBill(
  confirmation: unknown,
  fingerprint: string,
) {
  const supplied = z
    .object({ confirmedFingerprint: vendorBillFingerprint })
    .safeParse(confirmation);
  if (!supplied.success || supplied.data.confirmedFingerprint !== fingerprint) {
    throw new DomainError(
      409,
      "Review and confirm this exact bill before posting to QuickBooks Online.",
    );
  }
}
interface SupplierBillLineMapping {
  supplierSku: string;
  productName: string;
  internalSku: string;
  unit: string;
  expectedUnitCost: string;
  priceEffectiveOn: string;
  priceSource: string;
  stockConversion?: { unit: string; unitsPerBuyUnit: string };
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
    const conversion = mapping.stockConversion;
    const stock = conversion ? convertedSupplierLine(requested.quantity, requested.unitCost, conversion.unitsPerBuyUnit) : undefined;
    if (conversion && !stock) {
      throw new DomainError(409, `The approved unit conversion for ${requested.supplierSku} cannot preserve this quantity and bill line amount.`);
    }
    return {
      ...mapping,
      quantity: requested.quantity,
      billedUnitCost: requested.unitCost,
      totalCents: Number(totalCents),
      priceDiffers: billedCost !== expectedCost,
      ...(conversion && stock ? { stockLine: { ...stock, unit: conversion.unit } } : {}),
    };
  });
  const charges = input.charges?.map((charge) => ({ ...charge, totalCents: Number(scaled(charge.amount, 2)) })) ?? [];
  const totalCents = [...lines, ...charges].reduce((sum, item) => sum + item.totalCents, 0);
  if (totalCents <= 0 || totalCents !== Number(scaled(input.billTotal, 2))) {
    throw new DomainError(
      409,
      "The matched merchandise lines and account charges must equal the source bill total. Review units, quantities, prices, and charges before approval.",
    );
  }
  return {
    supplier: input.supplier,
    totalCents,
    priceDiffers: lines.some((item) => item.priceDiffers),
    lines,
    ...(charges.length ? { charges } : {}),
  };
}

function quickBooksDecimal(text: string) {
  const value = Number(text);
  const serialized = String(value);
  if (!supplierDecimalPattern.test(serialized) || scaled(serialized, 6) !== scaled(text, 6))
    throw new DomainError(409, "This converted stock unit quantity or price cannot be represented exactly in QuickBooks.");
  return value;
}

export function buildVendorBill(
  input: VendorBillInput,
  mappings: VendorBillLineMapping[],
  vendorId: string,
) {
  const reviewed = reviewVendorBill(input, mappings);
  const chargeLines = (reviewed.charges ?? []).map((charge) => {
    if (!charge.accountId) throw new DomainError(409, `Choose a QuickBooks expense account for ${charge.description}.`);
    return {
      Amount: charge.totalCents / 100,
      DetailType: "AccountBasedExpenseLineDetail" as const,
      Description: charge.description,
      AccountBasedExpenseLineDetail: { AccountRef: { value: charge.accountId } },
    };
  });
  return {
    ...reviewed,
    quickBooksBill: {
      VendorRef: { value: vendorId },
      DocNumber: input.billNumber,
      TxnDate: input.billDate,
      Line: [...reviewed.lines.map((item) => ({
        Amount: item.totalCents / 100,
        DetailType: "ItemBasedExpenseLineDetail" as const,
        Description: `${item.productName} (${item.supplierSku})`,
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: item.quickBooksItemId },
          Qty: item.stockLine ? quickBooksDecimal(item.stockLine.quantity) : Number(item.quantity),
          UnitPrice: item.stockLine ? quickBooksDecimal(item.stockLine.unitCost) : Number(item.billedUnitCost),
        },
      })), ...chargeLines],
    },
  };
}

function scaled(decimal: string, places: number) {
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt((whole || "0") + fraction.padEnd(places, "0"));
}

export type PreparedBill = ReturnType<typeof buildVendorBill>["quickBooksBill"];

export function matchesPostedBill(prepared: PreparedBill, posted: unknown) {
  const parsed = z
    .object({
      Id: z.string().regex(/^\d{1,30}$/),
      DocNumber: z.string(),
      TxnDate: z.string(),
      VendorRef: z.object({ value: z.string() }),
      CurrencyRef: z.object({ value: z.string() }).optional(),
      TxnTaxDetail: z.object({ TotalTax: z.number().optional() }).optional(),
      TotalAmt: z.number(),
      Line: z.array(
        z.object({
          DetailType: z.string(),
          Amount: z.number().optional(),
          Description: z.string().optional(),
          AccountBasedExpenseLineDetail: z.object({ AccountRef: z.object({ value: z.string() }) }).optional(),
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
  const financialLines = bill.Line.filter((line) => line.DetailType !== "SubTotalLineDetail");
  const totalCents = prepared.Line.reduce(
    (sum, item) => sum + Math.round(item.Amount * 100),
    0,
  );
  const itemKey = (
    amount: number,
    detail: { ItemRef: { value: string }; Qty: number; UnitPrice: number },
  ) =>
    JSON.stringify([
      "item",
      detail.ItemRef.value,
      detail.Qty,
      detail.UnitPrice,
      Math.round(amount * 100),
    ]);
  const accountKey = (amount: number, account: string, description: string) =>
    JSON.stringify(["account", account, description, Math.round(amount * 100)]);
  const expected = prepared.Line.map((line) => line.DetailType === "ItemBasedExpenseLineDetail"
    ? itemKey(line.Amount, line.ItemBasedExpenseLineDetail)
    : accountKey(line.Amount, line.AccountBasedExpenseLineDetail.AccountRef.value, line.Description)).sort();
  const received = financialLines.flatMap((line) => {
    if (line.Amount === undefined) return [];
    if (line.DetailType === "ItemBasedExpenseLineDetail" && line.ItemBasedExpenseLineDetail)
      return [itemKey(line.Amount, line.ItemBasedExpenseLineDetail)];
    if (line.DetailType === "AccountBasedExpenseLineDetail" && line.AccountBasedExpenseLineDetail && line.Description)
      return [accountKey(line.Amount, line.AccountBasedExpenseLineDetail.AccountRef.value, line.Description)];
    return [];
  }).sort();
  return (
    bill.DocNumber === prepared.DocNumber &&
    bill.TxnDate === prepared.TxnDate &&
    bill.VendorRef.value === prepared.VendorRef.value &&
    (!bill.CurrencyRef || bill.CurrencyRef.value === "USD") &&
    !bill.TxnTaxDetail?.TotalTax &&
    Math.round(bill.TotalAmt * 100) === totalCents &&
    financialLines.length === expected.length &&
    received.length === expected.length &&
    expected.every((key, index) => key === received[index])
  );
}

interface QuickBooksBillProvider {
  request(
    path: string,
    init?: RequestInit,
  ): Promise<{
    Vendor?: {
      Id: string;
      DisplayName?: string;
      Active?: boolean;
      CurrencyRef?: { value?: string };
    };
    Preferences?: {
      CurrencyPrefs?: {
        HomeCurrency?: { value?: string };
        MultiCurrencyEnabled?: boolean;
      };
    };
    Item?: { Id: string; Active?: boolean; Type: string };
    Account?: { Id: string; Name?: string; Active?: boolean; AccountType?: string };
    Bill?: unknown;
  }>;
  query(statement: string): Promise<{ QueryResponse?: { Bill?: unknown[] } }>;
}

export async function readQuickBooksBillChargeAccounts(
  ids: string[],
  request: QuickBooksBillProvider["request"],
) {
  return Promise.all([...new Set(ids)].map(async (id) => {
    const { Account: account } = await request(`/account/${id}`);
    const name = account?.Name?.trim();
    if (account?.Id !== id || !name || account.Active !== true ||
      !account.AccountType || !["Expense", "Other Expense", "Cost of Goods Sold"].includes(account.AccountType))
      throw new Error(`QuickBooks account ${id} must be an active expense or cost of goods sold account.`);
    return { id, name, type: account.AccountType };
  }));
}

export async function readQuickBooksVendorBillTarget(
  vendorId: string,
  request: QuickBooksBillProvider["request"],
) {
  const { Vendor: vendor } = await request(`/vendor/${vendorId}`);
  if (vendor?.Id !== vendorId || vendor.Active === false)
    throw new Error("The selected QuickBooks vendor is unavailable.");
  const { Preferences: preferences } = await request("/preferences");
  const currency = preferences?.CurrencyPrefs;
  if (
    currency?.HomeCurrency?.value !== "USD" ||
    (vendor.CurrencyRef && vendor.CurrencyRef.value !== "USD")
  ) {
    throw new Error(
      "Supplier bill export requires a QuickBooks company and vendor that use USD.",
    );
  }
  return {
    vendorName: vendor.DisplayName?.trim() ?? "",
    includeCurrency: currency.MultiCurrencyEnabled === true,
  };
}

export async function reconcileQuickBooksVendorBill(
  approved: PreparedBill,
  requestId: string,
  provider: QuickBooksBillProvider,
  reviewedTarget?: Awaited<ReturnType<typeof readQuickBooksVendorBillTarget>>,
  reviewedAccounts?: Awaited<ReturnType<typeof readQuickBooksBillChargeAccounts>>,
) {
  const vendorId = approved.VendorRef.value;
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
        "A different QuickBooks bill already uses this vendor bill number. Review it in Intuit.",
      );
    const existingId = postedBillId(existing[0]);
    if (!existingId)
      throw new Error(
        "QuickBooks returned no bill ID. Check the connected company before retrying.",
      );
    return { postedId: existingId, reconciledExisting: true };
  }
  const target = await readQuickBooksVendorBillTarget(vendorId, (path) =>
    provider.request(path),
  );
  if (
    reviewedTarget &&
    (reviewedTarget.vendorName !== target.vendorName ||
      reviewedTarget.includeCurrency !== target.includeCurrency)
  ) {
    throw new Error(
      "The QuickBooks vendor name or currency settings changed after review. Confirm the bill manually before posting.",
    );
  }
  for (const itemId of new Set(
    approved.Line.flatMap((line) => line.DetailType === "ItemBasedExpenseLineDetail" ? [line.ItemBasedExpenseLineDetail.ItemRef.value] : []),
  )) {
    const { Item: item } = await provider.request(`/item/${itemId}`);
    if (
      item?.Id !== itemId ||
      item.Active === false ||
      !["Inventory", "NonInventory", "Service"].includes(item.Type)
    )
      throw new Error(`QuickBooks item ${itemId} cannot receive this bill.`);
  }
  const accountIds = approved.Line.flatMap((line) => line.DetailType === "AccountBasedExpenseLineDetail" ? [line.AccountBasedExpenseLineDetail.AccountRef.value] : []);
  if (accountIds.length) {
    const currentAccounts = await readQuickBooksBillChargeAccounts(accountIds, (path) => provider.request(path));
    if (!reviewedAccounts || JSON.stringify(currentAccounts) !== JSON.stringify(reviewedAccounts))
      throw new Error("The QuickBooks expense accounts changed after review. Review the bill before posting.");
  }
  const document = target.includeCurrency
    ? { ...approved, CurrencyRef: { value: "USD" } }
    : approved;
  const { Bill: created } = await provider.request(
    `/bill?requestid=${requestId}`,
    { method: "POST", body: JSON.stringify(document) },
  );
  const postedId = postedBillId(created);
  if (!postedId)
    throw new Error(
      "QuickBooks returned no bill ID. Check the connected company before retrying.",
    );
  const { Bill: posted } = await provider.request(`/bill/${postedId}`);
  if (postedBillId(posted) !== postedId || !matchesPostedBill(approved, posted))
    throw new Error(
      `QuickBooks bill ${postedId} was posted but its details differ. Review it in Intuit.`,
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
