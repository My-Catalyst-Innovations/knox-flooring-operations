# Reviewed labor and receipt expenses

This release adds ordinary individual TimeActivity exports, paid receipt expenses (`Purchase`), and unpaid contractor labor bills (`Bill`). They are separate from warehouse issues, inventory valuation and stock supplier bills. These adapters have fixture and PostgreSQL workflow verification; a real connected Intuit sandbox is still required for provider acceptance. Nothing in these features pays a worker, initiates a transfer or completes payroll.

## Record and review the source

The owner opens a job's accounting costs panel. Existing crew time remains operational person-hours until the owner explicitly identifies one individual Employee or Vendor, confirms that the row belongs to that person, selects a verified active service item and records the actual hourly cost. Time must resolve to whole minutes, with at most 24 hours per individual row. The payload uses `CostRate`; it never converts internal cost into `HourlyRate`, a customer billing rate, or sends a payroll pay type. [Intuit TimeActivity schema](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/Data/IPPTimeActivity.php), [minor version support](https://static.developer.intuit.com/output_html/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions.html).

For a job expense, attach the original receipt as a private job document, then explicitly record its vendor, transaction date, reference, USD gross total and actual included tax. A paid receipt requires its actual Cash/Check/CreditCard choice and matching bank/card account. An unpaid contractor labor bill requires an actual due date and carries no payment account. The current adapter supports a US company using USD without conversion; receipt tax is included in the expense's cost, not claimed as recoverable tax. Different tax treatments and currencies require further implementation and review.

Each receipt document and its SHA-256 content can supply only one expense. Reuploading the same bytes does not create a second cost source. This initial workflow does not split one receipt across multiple jobs. Recording an expense never issues warehouse stock or adds a material-usage row.

A contractor bill may explicitly replace one same-job individually identified Vendor time row. The linked row is removed from tracked labor cost, and the actual bill enters receipt expense cost once. One time row cannot have two linked bills. The application blocks linking/approving the bill if that row already has an approved, submitting, unknown or confirmed TimeActivity, and blocks TimeActivity export while a linked contractor bill exists. Multi-row contractor allocations are not guessed. Unlinked receipts are explicitly additional costs; review manual cost totals for overlap.

The job response exposes tracked labor, unpriced labor count and tracked receipt expense. A positive manual labor actual remains an explicit override of the tracked labor total; otherwise the reviewed labor log supplies it. Receipt expenses are added once alongside labor, materials and manually recorded add-on costs. Unpriced time keeps cost completion visibly provisional.

## Accounting destination and authorization

Connect the intended company and reconcile its customer first. Each review shows the connection, realm, environment, source revision, verified references, receipt evidence and exact request. The owner explicitly chooses customer-only attribution or a verified true Project. A legacy customer subrecord is never used as a true Project. Project attribution requires the premium Projects scope and supported company described in the separate Projects setup guidance.

Sandbox writes require an authorized connected sandbox with `DEMO_MODE=false`. Production writes start disabled and require both `QUICKBOOKS_PRODUCTION_JOB_COSTS_ENABLED=true` and `QUICKBOOKS_PRODUCTION_JOB_COSTS_REALM_ID` equal to the saved connected realm. These flags authorize the adapter; they do not bypass per-source owner approval. Generic queue creation/approval cannot approve these financial records.

An approval freezes the original company connection, realm, environment, source, customer/Project mapping, verified references and exact payload. Changes require a new review. Source edits are blocked while an approval or submitted result exists. Cancel is available only before submission. Existing accounting and source history remains preserved rather than deleted.

## Submission and uncertain outcomes

The worker commits its submission claim before a financial request and supplies a durable `requestid` no longer than 50 characters. It validates the returned record's exact approved amount/rate, date, duration, individual, service, accounts and attribution before confirming it. A receipt reference collision with different financial content blocks submission. [Intuit request IDs](https://static.developer.intuit.com/output_html/qbo/docs/learn/learn-basic-field-definitions.html).

A network failure, unconfirmed response or failed local confirmation produces an unknown result. Reconcile performs provider reads only; it never repeats a financial POST. If no exact record is found, the unknown result remains paused for accounting investigation. A verified Intuit HTTP 400 `ValidationFault` is a rejected request: the owner can correct the source/mapping and make a fresh review. Other errors are not treated as proof that nothing was created.

After reconnecting the same realm and environment, the owner can reconcile an older submission using the current authorized connection. The original attempt UUID, payload and evidence stay unchanged. A different realm/environment is refused. An unsubmitted approval from an old connection must be cancelled and reviewed again before any fresh financial submission. If a local source changed after an uncertain result, reconciliation still checks only the originally approved document, retains that history and reports that the local change requires further accounting review.

## Verification and rollout

Migration `0024_job_accounting_projects` adds the new tables and labor/connection metadata without rewriting existing financial records. Include the schema snapshot and readiness version in the release, back up every affected company and run the serial tenant upgrade process before serving the new code. Existing release tests verify backup/restore across the full upgraded schema.

The disposable PostgreSQL workflow exercises actual owner routes, duplicate approvals, exact rate/time readback, lost responses, read-only reconciliation, same-company reconnect, changed source evidence, wrong realm/environment refusal, stale attribution claims, linked contractor cost exclusion, source receipt duplication and known validation correction. Provider transport is simulated in those tests. Finish acceptance with deliberately labeled sandbox records and the connected company's actual account/item/worker references before enabling an approved production realm. Do not use Will's live books for development testing.
