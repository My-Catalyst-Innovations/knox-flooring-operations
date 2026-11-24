# Reviewed active-job migration and cutover

This owner-only tool imports operational records or explicitly links retained source identities to existing jobs. It does not import receivables, payables, payments, opening balances, stock, purchase orders, crew bookings or provider transactions. It sends no messages and creates no invitations. Public signup and checkout are unchanged.

## Retained source and review

Use **Import active jobs** outside role preview. Export UTF-8 CSV or TSV with the header-only version 1 template; limits are 200 rows and 1 MiB of source bytes. `source_id` and `source_status` are required. Financial columns are refused. The browser rejects invalid UTF-8 and preserves BOM/CRLF; the server retains the original UTF-8 bytes and SHA-256 for a private attachment download. Formula-like text is retained as text and never evaluated.

Each source row requires an explicit create, link or skip decision. Create/link selects an existing unmerged customer and an explicitly chosen same-customer site (or no site). The saved review freezes customer revision, exact site content and, for a link, the existing job revision and content. No name-based customer or job merge occurs. A link adds provenance only and never changes the existing job or its financial eligibility. Retained source identities cannot be rebound, deleted or overwritten. Historical workspace labels are provenance; the trusted company database determines access after host adoption.

New jobs receive a Works job number, retain the original job number/status separately, and start with all nine financial fields explicitly `null`. Normal jobs keep their existing values and zero defaults. No source-created or source-stage timestamp is replaced with import time. Accepted date-only events remain calendar dates with unknown time; accepted offset timestamps retain their original text. Source dates remain available even when the owner defers adopting them. A missing commitment-recorded timestamp is not invented for timeliness reporting.

Safe entry stages stop at **Material Received**. A source scheduled/in-progress/unsupported stage requires an explicit supported entry-stage choice and reason; the original status remains visible. Closed source jobs belong in the historical archive. This entry-stage decision never establishes a real booking or completed work.

Preview, saved review, approval and commit are distinct operations. Approval/commit accept the exact immutable fingerprint only, with atomic replay. Changes to selected identities require another review. Every write rechecks and share-locks the actual active owner after database waits; preview roles do not qualify. Import locks have a finite timeout. Reads and writes use the selected company's database, with normal session and CSRF protection.

## Separate operational, forecast and billing reviews

The job's cutover panel records three separate evidence reviews and immutable approvals/commits:

- **Operational readiness:** selects the real current Works stage and reuses actual booking, materials and closeout readiness. It creates no schedule or stock entries and does not permit an owner override to stand in for cutover evidence. Routine actual workflow transitions can then continue. Changed scope or operational booking/material evidence can require another review. Calendar sync bookkeeping alone does not invalidate operational evidence.
- **Full-job forecast:** requires explicit integer-cent full-job revenue and labor/material/other forecast costs, saved same-job private evidence documents and a review basis. Values remain in a separate exact context. They never populate native actual revenue/costs, legacy balances or payments.
- **Remaining billing permission:** requires a separately evidenced gross amount **still billable after every legacy invoice, including unpaid legacy invoices**. This is a ceiling for future Works invoices, separate from the full contract and forecast. An explicit zero authorizes no positive new billing; it does not mean the customer paid. Legacy unpaid invoices are not recreated as Works receivables.

Financial reviews accept only existing same-job private document IDs with retained ownership/path/hash metadata. They do not fetch remote URLs. Approval/commit recaptures the current scope, source identity, document evidence and revision. Context becomes stale when its attributable scope changes. Customer sharing of imported job history remains off; review new customer-facing documents separately.

## Invoice ceiling and provider safeguards

Every direct imported-job invoice uses a stable UUID request key and current cutover revision. An uncertain response must retry the exact same frozen input. A confirmed validation rejection allows a new explicitly reviewed request. A request-identity conflict requires inspection of retained history rather than blind recreation.

Gross invoice totals, including drafts, consume the reviewed ceiling. Deposits, payments, voids, credits, refunds and status changes never silently replenish it. Existing consumption cannot move to another job, customer or null association. Imported invoices cannot be deleted. A customer merge cannot reattribute retained imported-job invoices. Only untouched pre-approval drafts can change their financial document under the current ceiling and exact invoice fingerprint; stale unsubmitted accounting reviews are cancelled atomically. Paid/refund/credit status cannot be established by a manual status change.

Requested monetary values are compared with PostgreSQL REAL readback before commit. Amounts that cannot be retained faithfully to the cent are rejected and the transaction rolls back, including claims and accounting review changes. This avoids silently rounding a requested amount into a different invoice. No broad rewrite of the existing financial storage model is performed.

Accepted remaining-work quote conversion shares the same ceiling/claim. It preserves the imported job's full context, stage/events and material records; replay returns the original converted invoice. It does not replace the job's full contract with a smaller remaining-work quote.

QuickBooks approval freezes the exact cutover proof, connected company UUID, realm and environment. The actual worker rechecks that proof immediately before any provider POST and durably locks the invoice document/consumption first. Stale scope/company or voided/credited/refunded documents cannot create an ordinary new provider invoice. Unknown results retain their original attempt for reconciliation; rejected requests do not free consumption. Ordinary local cost capture can continue while historical actuals are unknown. Provider job/cost exports require current operational cutover as well as their existing mappings, approvals and environment gates. No provider activation flags are widened by this feature.

## Reports and explicit limits

Only a current full-job forecast context participates in forecast revenue/margin reports. Source calendar-day events use the business calendar day without inferring a midnight timestamp. Reports expose exclusions for missing/stale financial context. Remaining billing permission is never used as full-job revenue or as a profit denominator.

Historical actual revenue/costs, full-job actual profit and commissions remain unknown and excluded for imported jobs. Newly recorded Works labor, material and receipt costs are displayed separately; they do not prove a complete historical baseline. This slice does not implement legacy AR/AP, historical payment reconciliation, a complete financial baseline import, or arbitrary unsupported stage conversion. Existing linked native jobs retain their ordinary behavior.

Migration `0030_active_job_cutover_import` adds eight provenance/review/consumption tables and changes only nine old job monetary columns to nullable, preserving their existing zero defaults and every existing row. It does not modify prior migrations. Deployment requires the normal independent backup, migration-preservation and recovery checks; no automatic HTTP migration is added.

## Verification

`pnpm --filter @workspace/db test:active-job-import` runs schema preservation and, when given an explicitly disposable loopback `TEST_DATABASE_URL`, the real PostgreSQL/auth/tenant workflow. The workflow blocks live providers and uses a controlled synthetic Intuit transport solely to prove actual worker claim/POST boundaries. It is not live QuickBooks acceptance. Run the full API/frontend/type/build checks and combined release/customer/archive/supplier/platform PostgreSQL regressions before integration. No live client or provider records are created by these tests.
