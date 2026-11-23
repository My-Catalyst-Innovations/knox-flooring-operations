# QuickBooks release safety — November 23, 2026

This release preserves the existing workspace-scoped database and secret routing, Inventory-item valuation, stock reconciliation, supplier bills, reviewed invoices, and Outlook sender selection. It does not introduce a second accounting or Microsoft provider.

The connection fixes serialize token rotation in PostgreSQL, retain valid authorization on temporary token-service failures, and use the environment saved with the connected company. OAuth callbacks now require an unexpired state tied to the signed-in owner and session. A durable, unique audit event prevents state reuse, and connection replacement is transactional.

Customer reconciliation prioritizes existing company-scoped links and avoids matching blank contact fields. Email dots and plus tags are retained. Invoice payment imports recheck the company and mapping under a transaction before applying remote balances, and preserve the existing optimistic check against concurrent local edits.

## Projects limitation

True QuickBooks Projects API capability is not verified. The previous generic project exporter created a customer subrecord with `Job: true`; this is not evidence of Projects support. New project exports are now blocked and the connection screen states this limitation. Existing legacy subcustomer mappings and the other accounting workflows are preserved. Actual Projects capability and its accounting references must be implemented and verified against the selected Intuit company before claiming that requirement is satisfied.

## Verification boundary

Targeted automated tests cover concurrent refreshes, temporary versus revoked authorization, saved-company routing, OAuth owner/session/expiry/replay validation, atomic connection rollback, reconciliation identities, and in-flight invoice changes. These are mocked provider tests. They do not replace Intuit sandbox validation or bookkeeper approval of the accounting mappings and treatment. No live accounting records or credentials were used to verify these changes.
