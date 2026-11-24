# Owner-only legacy history archive

This separate migration slice retains read-only historical records and privately
claimed original files. It does not import active jobs, quotes, invoices, purchase
orders, payments, stock, accounting balances, customer links or supplier links.
Historical status, references and monetary prose remain source text. They never
enter operational dashboards, job costing or QuickBooks exports.

## Remaining migration scope

The preceding customer-import slice handles reviewed customer contacts and an
optional new site, with immutable source provenance. Catalog imports and the
supplier crosswalk handle products, supplier SKU/manufacturer aliases, units and
approved dated prices; they are not a supplier contact/address master. Supplier
contacts, reviewed active-job/open-order conversion and opening-balance accounting
reconciliation remain separate work. This archive is not a second ledger or a
replacement for that implementation review.

## Source contract and reviewed commit

An actual owner outside role preview can use `/legacy-history`. Version 1 accepts
UTF-8 CSV or TSV with 1–200 source rows and at most 1 MiB of source bytes:

```text
source_id,type,title,reference,party_name,occurred_on,status,summary
```

`source_id`, `type` and `title` are required columns. All other columns are
optional. Unsupported or duplicate headers are refused. Supported types are
`job`, `quote`, `invoice`, `purchase_order`, `payment`, and `other`. IDs remain
text, including leading zeros. Historical dates must be real `YYYY-MM-DD` values
or blank when unknown; no current or estimated date is substituted. Values are
plain text and are never evaluated as formulas, code, HTML or remote links.

The browser reads file bytes with fatal UTF-8 decoding and preserves BOM and line
endings. Non-UTF-8 files must first be exported as UTF-8. The exact submitted UTF-8
source string, filename and SHA-256 are retained. Parsed fields are trimmed and
quoted line endings normalized for the searchable record; the retained source
CSV remains available with its original BOM/CRLF bytes. Pasted input retains the
exact entered text. The source download has a fixed safe attachment filename.

Each source system and batch ID identifies one immutable source file. The owner
must preview it, decide `archive` or `skip` for every row, save a review note,
approve the exact review fingerprint, then explicitly confirm and commit the
approved read-only batch. Invalid rows, duplicate file identities and identities
already archived must be corrected or explicitly skipped with a reason. No source
identity is guessed, overwritten, merged or attached to an active business record.
A conflicting file for the same source/batch ID is refused.

The source identity is `(source system, historical type, source ID)` in the
selected company database. Another batch with that identity cannot replace the
original, even if its text changed. A conflict requires explicit skip or a future
reviewed correction process; this version does not implement historical revision
replacement. Refreshing a pending review retains prior immutable approvals and
invalidates its current approval. New identities appearing after review force a
fresh review. A committed batch, its records and original accepted approvals
cannot be edited or deleted through the app or ordinary SQL updates/deletes.

## Private original files

After a record is committed, an owner can explicitly attach an original PDF,
JPEG, PNG, WebP or GIF up to 15 MiB. Word/Excel/ZIP/HTML/SVG and other formats are
outside this version. The existing private upload store is reused with an
owner-only `legacy-document` purpose, bound to the committed historical record.
Filename and supported content signature must agree. Files are not opened,
evaluated, rendered inline, published or automatically copied to Microsoft.

The owner confirms the selected original belongs to that record. The server
verifies uploader, record, purpose and actual bytes, then saves an immutable
SHA-256/size/name claim and audit entry. A retry uses the same file path and UUID
request key; changing its file, actor or record is refused. A new claim for content
already attached is refused and the owner opens the existing saved claim.

Original downloads require an actual owner in the same company, use only the
record's private claim, and verify current ownership metadata, SHA-256, size and
name before streaming. Changed bytes return a conflict. Generic storage paths,
uploader previews, guessed IDs, customer portals and public URLs cannot bypass
these checks. There is no remote-URL input or arbitrary remote fetching.

## API and storage boundaries

- `/api/legacy-history` provides bounded source/type/search/page filters.
- `/api/legacy-history/:id` returns history and its source/approval/document claims.
- `/api/legacy-history/:id/export` downloads record/provenance JSON.
- `/api/legacy-history/imports` and its preview/review/approve/commit/refresh paths
  retain the reviewed import lifecycle.
- `/api/legacy-history/imports/:id/source` downloads the original UTF-8 CSV.
- `/api/legacy-history/:id/documents` accepts the explicit private original claim.
- `/api/legacy-history/documents/:id/download` downloads a hash-verified original.
- `/api/storage/files/legacy-document` uploads privately for a committed record.

Every archive endpoint uses actual-owner authorization, role-preview refusal,
normal cookie/CSRF protection, the existing trusted host/database selection and
no-store responses. Source JSON escaping can exceed the CSV's byte size, so only
the archive preview endpoint has a 3 MiB transport parser; all other JSON routes
retain their original limit and the source parser still enforces 1 MiB.

Migration `0026_legacy_history_archive` adds four dedicated archive tables,
foreign keys, indexes and immutable-history/source triggers. It changes no
existing operational columns or records. It is a separate batch after the
`0025` customer-import release and must follow normal backup, migration,
compatible-recovery and client acceptance procedures before deployment.

## Verification

The real PostgreSQL/app fixture covers owner/preview/CSRF/tenant isolation, exact
UTF-8 source bytes, leading-zero IDs, inert formula-shaped fields, transport/row
limits, explicit approval, concurrent replay, identity conflicts, atomic rollback,
private document ownership/types/checksums/downloads and immutable audit history.
It compares all original business/financial/stock/customer/auth tables before and
after: no active records change. Only simulated private Blob requests are allowed;
no real provider, live financial record, invitation or production import is used.
