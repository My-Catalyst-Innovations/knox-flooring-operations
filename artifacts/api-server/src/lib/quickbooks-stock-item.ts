import { createHash } from "node:crypto";
import { z } from "zod";
import { loadQuickBooksCatalogEntity } from "./quickbooks-catalog";
import { QuickBooksRequestError } from "./quickbooks";

export const sandboxStockItemEntity = "sandbox_stock_item";
const accountId = z.string().regex(/^\d{1,30}$/);
export const sandboxStockItemInput = z.object({
  productId: z.string().min(1).max(200),
  connectionId: z.string().min(1).max(200),
  incomeAccountId: accountId,
  cogsAccountId: accountId,
  assetAccountId: accountId,
  inventoryStartDate: z.string().date(),
});
type Input = z.infer<typeof sandboxStockItemInput>;
type Connection = {
  status: string;
  environment: string;
  realmId: string;
  id: string;
};
type Provider = {
  query: Parameters<typeof loadQuickBooksCatalogEntity>[1];
  request(path: string, init?: RequestInit): Promise<unknown>;
};
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const reference = (value: string) => ({ value });
const accountSchema = z.object({
  Id: accountId,
  Name: z.string().min(1),
  Active: z.literal(true),
  AccountType: z.string(),
  AccountSubType: z.string(),
});
const itemSchema = z.object({
  Id: accountId,
  SyncToken: z.string(),
  Sku: z.string(),
  Name: z.string(),
  Active: z.literal(true),
  Type: z.literal("Inventory"),
  TrackQtyOnHand: z.literal(true),
  QtyOnHand: z.literal(0),
  InvStartDate: z.string(),
  IncomeAccountRef: z.object({ value: accountId }),
  ExpenseAccountRef: z.object({ value: accountId }),
  AssetAccountRef: z.object({ value: accountId }),
});

export function inventorySandboxAvailable(
  connection: Connection | null,
  environment = process.env.QUICKBOOKS_ENVIRONMENT,
) {
  return (
    environment === "sandbox" &&
    connection?.status === "connected" &&
    connection.environment === "sandbox"
  );
}

export async function prepareSandboxStockItem(
  product: {
    id: string;
    sku: string;
    name: string;
    active: boolean;
    inventoryType: string;
  },
  realmId: string,
  input: Input,
  provider: Provider,
) {
  const name = product.name.trim();
  const sku = product.sku.trim();
  if (
    !product.active ||
    product.inventoryType !== "Inventory" ||
    !sku ||
    sku.length > 100 ||
    !name ||
    name.length > 100 ||
    /[:\r\n\t]/.test(name) ||
    /[\r\n\t]/.test(sku)
  )
    throw new Error(
      "Choose an active stocked product with a valid QuickBooks name and internal SKU.",
    );
  const requested = [
    {
      id: input.incomeAccountId,
      label: "Sales of Product Income",
      type: "Income",
      subtype: "SalesOfProductIncome",
    },
    {
      id: input.cogsAccountId,
      label: "Cost of Goods Sold",
      type: "Cost of Goods Sold",
    },
    {
      id: input.assetAccountId,
      label: "Inventory Asset",
      type: "Other Current Asset",
      subtype: "Inventory",
    },
  ];
  if (new Set(requested.map(({ id }) => id)).size !== requested.length)
    throw new Error("Select three distinct QuickBooks accounts.");
  const accounts = await Promise.all(
    requested.map(async ({ id, label, type, subtype }) => {
      const response = z
        .object({ Account: accountSchema })
        .safeParse(await provider.request(`/account/${id}`));
      const account = response.success ? response.data.Account : undefined;
      if (
        account?.Id !== id ||
        account.AccountType !== type ||
        (subtype && account.AccountSubType !== subtype)
      )
        throw new Error(`Select an active ${label} account in this sandbox.`);
      return { id, name: account.Name, label };
    }),
  );
  const document = {
    Name: name,
    Sku: sku,
    Type: "Inventory" as const,
    TrackQtyOnHand: true,
    QtyOnHand: 0,
    InvStartDate: input.inventoryStartDate,
    IncomeAccountRef: reference(input.incomeAccountId),
    ExpenseAccountRef: reference(input.cogsAccountId),
    AssetAccountRef: reference(input.assetAccountId),
  };
  const requestId = `cwitem-${fingerprint(["sandbox", realmId, product.id]).slice(0, 43)}`;
  return {
    realmId,
    document,
    accounts,
    requestId,
    fingerprint: fingerprint([requestId, document, accounts]),
  };
}

type Prepared = Awaited<ReturnType<typeof prepareSandboxStockItem>>;

function matchesItem(prepared: Prepared, value: unknown) {
  const parsed = itemSchema.safeParse(value);
  if (!parsed.success) return;
  const item = parsed.data;
  const expected = prepared.document;
  if (
    item.Sku === expected.Sku &&
    item.Name === expected.Name &&
    item.InvStartDate === expected.InvStartDate &&
    item.IncomeAccountRef.value === expected.IncomeAccountRef.value &&
    item.ExpenseAccountRef.value === expected.ExpenseAccountRef.value &&
    item.AssetAccountRef.value === expected.AssetAccountRef.value
  )
    return item;
  return undefined;
}

export async function findSandboxStockItem(
  prepared: Prepared,
  provider: Provider,
) {
  const catalog = await loadQuickBooksCatalogEntity("Item", provider.query);
  const expected = prepared.document;
  const matches = catalog.filter(
    (item) =>
      item.Sku?.trim().toLowerCase() === expected.Sku.toLowerCase() ||
      item.Name?.trim().toLowerCase() === expected.Name.toLowerCase(),
  );
  if (!matches.length) return;
  const item =
    matches.length === 1 ? matchesItem(prepared, matches[0]) : undefined;
  if (!item)
    throw new Error(
      "A different or inactive sandbox item already uses this SKU or name. Review it in Import & reconcile.",
    );
  return item;
}

export async function exportSandboxStockItem(
  prepared: Prepared,
  provider: Provider,
  linkedId?: string,
) {
  const existing = await findSandboxStockItem(prepared, provider);
  if (linkedId && existing?.Id !== linkedId)
    throw new Error(
      "The approved sandbox item differs from the saved product link. Reconcile the existing product first.",
    );
  if (existing) return { item: existing, reconciledExisting: true };
  let response: unknown;
  try {
    response = await provider.request(`/item?requestid=${prepared.requestId}`, {
      method: "POST",
      body: JSON.stringify(prepared.document),
    });
  } catch (error) {
    if (
      error instanceof QuickBooksRequestError &&
      ["600", "6240"].includes(error.faultCode ?? "")
    ) {
      const recovered = await findSandboxStockItem(prepared, provider);
      if (recovered) return { item: recovered, reconciledExisting: true };
    }
    throw error;
  }
  const created = z
    .object({ Item: z.object({ Id: accountId }) })
    .safeParse(response);
  if (!created.success)
    throw new Error(
      "QuickBooks returned no inventory item ID. Reconcile the sandbox before retrying.",
    );
  const id = created.data.Item.Id;
  const read = z
    .object({ Item: z.unknown() })
    .safeParse(await provider.request(`/item/${id}`));
  const item = read.success ? matchesItem(prepared, read.data.Item) : undefined;
  if (!item || item.Id !== id)
    throw new Error(
      "The returned sandbox item differs from the approved SKU, accounts, date, or zero quantity. Reconcile before retrying.",
    );
  return { item, reconciledExisting: false };
}
