import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, quickbooksJobCostExportsTable } from "@workspace/db";
import { requireOwner } from "../middlewares/auth";
import { domainRoute, parse } from "../lib/domain-http";
import { DomainError } from "../lib/operations-rules";
import { getConnection } from "../lib/quickbooks";
import { loadQuickBooksCatalogEntity } from "../lib/quickbooks-catalog";
import {
  costSelection,
  jobCostExportsAvailable,
} from "../lib/quickbooks-job-cost";
import {
  accountingCosts,
  approveJobCost,
  cancelJobCost,
  createExpense,
  expenseCreate,
  expensePatch,
  laborAccountingInput,
  prepareJobCost,
  processJobCostExport,
  providerFor,
  updateExpense,
  updateLaborAccounting,
} from "../lib/job-accounting";

const router = Router();
router.get(
  "/jobs/:id/accounting-costs",
  requireOwner,
  domainRoute(async (req, res) =>
    res.json(await accountingCosts(String(req.params.id))),
  ),
);
router.get(
  "/jobs/:id/expenses",
  requireOwner,
  domainRoute(async (req, res) =>
    res.json((await accountingCosts(String(req.params.id))).expenses),
  ),
);
router.post(
  "/jobs/:id/expenses",
  requireOwner,
  domainRoute(async (req, res) =>
    res
      .status(201)
      .json(
        await createExpense(
          String(req.params.id),
          parse(expenseCreate, req.body) as z.output<typeof expenseCreate>,
          req.auth!.userId,
        ),
      ),
  ),
);
router.patch(
  "/jobs/:id/expenses/:expenseId",
  requireOwner,
  domainRoute(async (req, res) =>
    res.json(
      await updateExpense(
        String(req.params.id),
        String(req.params.expenseId),
        parse(expensePatch, req.body),
        req.auth!.userId,
      ),
    ),
  ),
);
router.patch(
  "/jobs/:id/labor/:entryId/accounting",
  requireOwner,
  domainRoute(async (req, res) =>
    res.json(
      await updateLaborAccounting(
        String(req.params.id),
        String(req.params.entryId),
        parse(laborAccountingInput, req.body),
        req.auth!.userId,
      ),
    ),
  ),
);
router.get(
  "/quickbooks/job-costs/options",
  requireOwner,
  domainRoute(async (_req, res) => {
    const connection = await getConnection();
    if (!connection)
      throw new DomainError(409, "Connect a QuickBooks company first.");
    const provider = providerFor(connection.id),
      lists = (await Promise.all(
        ["Employee", "Vendor", "Item", "Customer", "Account"].map((entity) =>
          loadQuickBooksCatalogEntity(entity as "Employee", provider.query),
        ),
      )) as any[][];
    const options = (
      records: any[],
      predicate: (row: any) => boolean = () => true,
    ) =>
      records
        .filter((row) => row.Active === true && predicate(row))
        .map((row) => ({
          id: row.Id,
          name:
            row.DisplayName ||
            row.Name ||
            `${row.GivenName ?? ""} ${row.FamilyName ?? ""}`.trim(),
        }))
        .filter((row) => row.name);
    res.json({
      enabled: jobCostExportsAvailable(connection),
      company: {
        connectionId: connection.id,
        realmId: connection.realmId,
        environment: connection.environment,
        name: connection.companyName,
      },
      employees: options(lists[0]),
      vendors: options(lists[1]),
      serviceItems: options(lists[2], (row) => row.Type === "Service"),
      customers: options(lists[3]),
      expenseAccounts: options(lists[4], (row) =>
        ["Expense", "Cost of Goods Sold", "Other Expense"].includes(
          row.AccountType,
        ),
      ),
      bankAccounts: options(lists[4], (row) => row.AccountType === "Bank"),
      creditCardAccounts: options(
        lists[4],
        (row) => row.AccountType === "Credit Card",
      ),
    });
  }),
);
function kind(value: unknown) {
  return parse(z.enum(["labor", "expense"]), value);
}
const safe = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      409,
      error instanceof Error
        ? error.message
        : "Review the QuickBooks cost mapping before continuing.",
    );
  }
};
router.post(
  "/quickbooks/job-costs/:kind/:id/review",
  requireOwner,
  domainRoute(async (req, res) =>
    res.json(
      await safe(() =>
        prepareJobCost(
          kind(req.params.kind),
          String(req.params.id),
          parse(costSelection, req.body),
        ),
      ),
    ),
  ),
);
router.post(
  "/quickbooks/job-costs/:kind/:id/approve",
  requireOwner,
  domainRoute(async (req, res) => {
    const { fingerprint, ...selection } = parse(
      costSelection
        .extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      req.body,
    );
    const prepared = await safe(() =>
      prepareJobCost(kind(req.params.kind), String(req.params.id), selection),
    );
    if (prepared.fingerprint !== fingerprint)
      throw new DomainError(
        409,
        "The source or accounting evidence changed. Review the current preview before approving.",
      );
    res.json(await approveJobCost(prepared, req.auth!.userId));
  }),
);
const operation = z.object({ connectionId: z.string().min(1) }).strict();
router.post(
  "/quickbooks/job-costs/exports/:exportId/reconcile",
  requireOwner,
  domainRoute(async (req, res) => {
    const input = parse(operation, req.body),
      [attempt] = await db
        .select()
        .from(quickbooksJobCostExportsTable)
        .where(
          eq(quickbooksJobCostExportsTable.id, String(req.params.exportId)),
        );
    const current = await getConnection();
    if (
      !attempt ||
      !current ||
      current.id !== input.connectionId ||
      current.status !== "connected" ||
      current.realmId !== attempt.realmId ||
      current.environment !== attempt.environment
    )
      throw new DomainError(
        404,
        "Accounting export not found in this company.",
      );
    res.json(await safe(() => processJobCostExport(attempt.id)));
  }),
);
router.post(
  "/quickbooks/job-costs/exports/:exportId/cancel",
  requireOwner,
  domainRoute(async (req, res) =>
    res.json(
      await cancelJobCost(
        String(req.params.exportId),
        parse(operation, req.body).connectionId,
        req.auth!.userId,
      ),
    ),
  ),
);
export default router;
