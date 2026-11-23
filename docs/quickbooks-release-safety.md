# QuickBooks release safety — November 23, 2026

This release preserves the existing workspace-scoped database and secret routing, Inventory-item valuation, stock reconciliation, supplier bills, reviewed invoices, and Outlook sender selection. It does not introduce a second accounting or Microsoft provider.

The connection fixes serialize token rotation in PostgreSQL, retain valid authorization on temporary token-service failures, and use the environment saved with the connected company. OAuth callbacks now require an unexpired state tied to the signed-in owner and session. A durable, unique audit event prevents state reuse, and connection replacement is transactional.

Customer reconciliation prioritizes existing company-scoped links and avoids matching blank contact fields. Email dots and plus tags are retained. Invoice payment imports recheck the company and mapping under a transaction before applying remote balances, and preserve the existing optimistic check against concurrent local edits.

## True Projects and legacy subcustomers

True Projects use a separate GraphQL adapter and mapping table. The previous generic exporter used customer subrecords with `Job: true`; those legacy links remain intact and that exporter stays blocked. Owner controls on each job can list and explicitly link an existing, open Project belonging to its verified QuickBooks customer, or prepare and approve a new Project's exact name and description. Invoices retain both the customer reference and the separate, verified top-level `ProjectRef`.

Every action requires the actual saved `project-management.project` grant, the connected company's `ProjectsEnabled` preference, and a successful GraphQL capability probe. The owner can request incremental consent from Settings; requesting consent does not establish Intuit app entitlement or buy a subscription. OAuth state records the exact requested scopes. A successful code exchange that omits `scope` uses that immutable request, as permitted by OAuth; an explicit response stores only the returned subset. Token refresh preserves saved scopes when omitted and never adds a configured scope.

Creation has a durable, company-bound approval and a single submission. It has no automatic mutation retry or invented provider idempotency parameter. A lost response leaves an unconfirmed review; owner reconciliation searches bounded, paginated results for the exact customer, name and immutable description marker. Incomplete results cannot prove absence. Reconnecting the same company preserves the original submission history and blocks another creation. A changed company/customer/job, foreign Project, closed or unknown Project status, or changed approved Project details blocks export pending review.

The transport and GraphQL shapes follow the [official Intuit Projects sample](https://github.com/IntuitDeveloper/SampleApp-Project-NodeJS). Its Projects-specific client uses bearer authorization; company binding is also checked through REST reads at the saved realm. Customer ownership is filtered locally because the sample documents unsupported server filters. The preference and top-level Project reference follow the [official Projects integration prompt](https://github.com/IntuitDeveloper/Prompt-Library/blob/main/discover/generated-prompts/projects-ready-prompt.md) and [Invoice reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice).

## Verification boundary

Automated tests cover concurrent refreshes, saved-company routing, OAuth owner/session/expiry/replay validation, omitted and reduced scope grants, transactional connection replacement, Project pagination/customer ownership, single submission after a lost response, and invoice Project reference comparison. The disposable PostgreSQL/router fixture simulates Intuit responses; it does not establish live Intuit Projects entitlement or replace sandbox acceptance and bookkeeper approval. No live accounting records or credentials were used to verify these changes.
