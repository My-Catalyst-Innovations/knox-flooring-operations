# Outstanding purchase-order cutover

This owner-only import carries quantities still due from suppliers into Works.
It is a one-time reviewed cutover, not an ongoing synchronization or an import of
historical inventory or financial balances. Opening the page performs local reads
only. Creating a preview, saving mappings, approving and committing are separate
explicit actions. Role preview cannot use these controls.

## Source contract

Use a UTF-8 CSV or TSV up to 200,000 bytes and 200 source lines, at most 100 lines
per purchase order. The header-only download contains these exact columns:

```csv
source_po_id,source_po_number,source_line_id,source_status,supplier_ref,warehouse_ref,job_ref,product_ref,unit,ordered_qty,received_qty,cancelled_qty,outstanding_qty,unit_cost,currency,expected_on
```

All source identifiers, numbers, statuses and decimal strings remain text in the
retained source/provenance. No spreadsheet formulas or remote URLs are evaluated.
The exact supplied UTF-8 bytes, including a chosen file's BOM and CRLF endings,
are retained with a SHA-256 digest. Pasted text is the source as supplied by the
browser. Invalid UTF-8, unsupported headers, invalid source PO identities or an
oversized source are refused. Selecting an invalid new file clears any earlier
local source so it cannot accidentally be submitted instead.

The owner supplies the actual source snapshot and cutover timestamps with time
zones. Both must be past instants, and snapshot cannot be later than cutover.
These timestamps are evidence, not scheduling instructions. The owner explicitly
confirms that the source order remains open and the exact outstanding quantities
remain due at cutover, including activity since the snapshot.

Quantities use nonnegative plain decimals with at most six fractional places and
a maximum of1,000,000 per source quantity; originally ordered must be positive.
Ordered minus received minus cancelled must equal outstanding exactly. The
parser uses integer micros rather than binary floating-point arithmetic. Source
cost is required, uses at most 12 whole and six fractional digits, and is never
replaced by a catalog cost, a supplier price or a calculated average. A genuine
zero source cost needs an explicit explanatory reason of at least 10 characters.
Only explicitly declared USD and exact matching product stock units are supported.
There is no currency or purchase-unit conversion in this version.

Header values must agree across every line of one source PO. Duplicate source
line IDs, incompatible units, missing costs and inconsistent quantities block
creation/linking. Invalid source orders can be explicitly skipped with a reason;
otherwise correct the source and start a new snapshot. Closed or zero-remaining
lines are retained as evidence and must be explicitly skipped. Different source
lines cannot be silently combined or averaged into a single stock product.

## Review and commit

For every source order, the owner explicitly selects create, link or skip. For
create/link, every line is explicitly included or skipped. Included lines need
existing active stocked products, a selected active supplier, a warehouse and an
explicit existing-job link or no-job choice. A source containing a job reference
cannot silently drop that link. Searchable, paginated local pickers never select
a default match. Missing master records must be created through their normal
workflows before review.

The saved review freezes supplier ID/revision/name, warehouse identity/timestamp,
product ID/revision/unit and descriptive snapshot, optional job revision/timestamp,
and any selected existing order's complete reviewed lines and receipt digest.
The current supplier contact master is separate from existing PO supplier text;
this import retains the supplier ID/name in provenance and writes only the normal
supplier-name snapshot into a newly created core PO.

An owner approves the exact saved fingerprint, then separately confirms commit.
Edits invalidate local approval; changed operational records block commit and
require a refreshed review. Transactions recheck the active owner and use bounded
local locks. No provider/network work occurs under those locks. A competing edit
or lock conflict rolls back the entire batch. Retrying the same approved commit
returns the original saved result, including after a lost response.

Create adds one normal-numbered **Ordered** Works PO and only its explicitly
included outstanding quantities, with exact source unit costs. The original
source PO number is displayed beside the generated Works number. Earlier source
receipts do not become Works receipts, stock or acquisition-cost layers. The
normal receiving workflow is used only for real deliveries after cutover.

Link adds immutable provenance to an existing open PO and changes none of its
fields or receipt history. The existing supplier, warehouse, job, expected date,
and all outstanding product quantities/costs must exactly match the saved review.
One Works PO cannot be claimed by two source identities. Existing receipts,
including damage-only entries, are fingerprinted so a changed receipt snapshot
requires new review. The main PO page distinguishes a newly created
outstanding-only import from an unchanged existing order linked to a source.
Line provenance records the actual Works line ID and ordered quantity separately
from the quantity still outstanding at cutover, including for linked old orders.

Source identity is unique within the trusted company database, independent of a
later hostname/workspace-label change. Re-importing an already claimed source PO
cannot overwrite or duplicate it. Source snapshots, approvals and accepted
provenance are immutable; corrections use separately reviewed normal workflows.

## Boundaries and dependencies

The import does not create customers, jobs, suppliers, products, aliases, prices,
bookings, calendar events, receipts, stock movements, reservations, bills,
invoices, payments, accounting queues, public links or communications. Active-job
migration and historical financial balances are separate work.

Development and isolated tests do not require a provider account or Will's data.
Real cutover requires an approved source snapshot and existing reviewed supplier,
warehouse, product and optional job mappings. Source schema 0029 depends on the
complete supplier 0028 schema; deployment must use the normal reviewed migration,
backup and recovery process. No production import or provider activation is part
of source validation.

The supplier directory/runtime slice is also an integration dependency: the
schema checkpoint alone does not provide supplier contact entry screens. This
import deliberately links existing master records rather than creating them.
