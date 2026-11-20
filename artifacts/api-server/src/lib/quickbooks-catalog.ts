export const quickBooksCatalogEntities = [
  "Customer",
  "Item",
  "TaxCode",
  "Account",
  "Employee",
  "Vendor",
] as const;
type CatalogEntity = (typeof quickBooksCatalogEntities)[number];
type QuickBooksRecord = {
  Id: string;
  Active?: boolean;
  Type?: string;
  Name?: string;
  Sku?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  DisplayName?: string;
};

const pageSize = 1000;

export async function loadQuickBooksCatalogEntity(
  entity: CatalogEntity,
  query: (
    statement: string,
  ) => Promise<{ QueryResponse?: Record<string, QuickBooksRecord[]> }>,
): Promise<QuickBooksRecord[]> {
  const records = new Map<string, QuickBooksRecord>();
  const order =
    entity === "Item" ? " where Active IN (true, false) orderby Name" : "";
  for (let start = 1; ; start += pageSize) {
    const { QueryResponse } = await query(
      `select * from ${entity}${order} startposition ${start} maxresults ${pageSize}`,
    );
    if (!QueryResponse)
      throw new Error(
        `QuickBooks did not return a catalog response for ${entity}.`,
      );
    const page = QueryResponse[entity] ?? [];
    if (
      !Array.isArray(page) ||
      page.length > pageSize ||
      page.some((entry) => !entry || typeof entry.Id !== "string" || !entry.Id)
    ) {
      throw new Error(
        `QuickBooks returned an invalid catalog page for ${entity}.`,
      );
    }
    const priorCount = records.size;
    for (const entry of page) records.set(entry.Id, entry);
    if (page.length && records.size === priorCount) {
      throw new Error(
        `QuickBooks repeated a catalog page for ${entity}. Reconcile again.`,
      );
    }
    if (page.length < pageSize) return [...records.values()];
  }
}
