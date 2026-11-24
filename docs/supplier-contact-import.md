# Supplier contacts and reviewed source import

This slice adds a real supplier contact directory. Existing products, purchase
orders, materials and approved supplier SKU crosswalks still retain their original
supplier text. Creating or linking a directory contact does not rename those
labels, create a SKU alias, change a negotiated price, receive stock, create an
order, set an accounting balance, map a QuickBooks Vendor or send a message.

## Owner directory

Only an actual owner outside role preview can read or mutate `/suppliers` and
`/supplier-imports`. The normal session, CSRF, trusted host and selected company
database boundaries apply. All responses are private/no-store.

Owners can add a supplier manually, edit contact/address/notes fields with the
current revision, and explicitly deactivate or reactivate it with an audit reason.
The supplier's ID and canonical name are retained. Names use a unique database
`lower(btrim(name))` key consistent with existing bill-label normalization; leading
and trailing spaces, blank names and control characters are refused. An inactive
supplier retains its name, so deactivation cannot create another identity with the
same canonical name. Deactivation affects this directory's availability only;
existing purchasing records are not rewritten or cancelled.

Contact edits cannot rename a supplier or change its active flag. Delete and
merge requests return an actionable conflict: retain the original identity and
source links, and use deactivation. Database triggers also preserve canonical
identity and prohibit deletion; source links additionally use restricted foreign
keys. There is no automatic merge, rename, external account connection or provider
export in this version.

## Version 1 source contract

The importer accepts UTF-8 CSV or TSV, up to 1 MiB of original source bytes and
1–200 rows. Its fixed columns are:

```text
source_id,name,contact_name,email,phone,address,city,state,postal_code,country,notes
```

`source_id` and `name` are required; other columns are optional. Unknown,
financial, duplicate or missing identity columns are refused. IDs, phone numbers
and postal codes remain text, including leading zeros. Country and address fields
are retained contact text; the importer does not infer jurisdictions, taxes,
payment terms, account numbers or postal validation.

The browser reads the selected bytes using fatal UTF-8 decoding with BOM
preservation. BOM, CRLF and the exact submitted source string remain downloadable;
parsed searchable fields are trimmed separately. Invalid or unreadable selected
files clear the prior source, so an older file cannot be imported accidentally.
Non-UTF-8 files must be exported as UTF-8 first. Pasted input retains its exact
entered text. Source and formula-shaped values are never evaluated, rendered as
HTML or fetched as remote content. Original CSV is an attachment with a fixed
safe filename; source values remain inert React text in the app.

## Explicit review and immutable history

A source system and batch ID identify one immutable source file and SHA-256.
Previewing a different file under that identity returns a conflict. Preview does
not create suppliers. Possible name, email and phone matches are suggestions, not
automatic links. Existing purchase/product supplier labels are shown as evidence;
they never become contact or SKU aliases through this importer.

The owner must decide create, link or skip for every row and save a batch review
note. Skips and links require an explanation. Creating a separate supplier despite
contact/name hints or existing legacy labels also requires an explanation.
Duplicate source IDs cannot be imported, and multiple new supplier identities
cannot share a canonical name. An exact existing name requires selecting that
active supplier, or skipping the row; inactive suppliers must first be explicitly
reactivated. Different contact hints never justify silently selecting a party.

An owner may explicitly select another existing active supplier from the directory
when the source uses a different historical label. The saved decision binds its
ID, revision and complete current contact snapshot. Linking stores source
provenance and does not overwrite any current contact or create a purchasing alias.
The owner approves the exact saved fingerprint, then explicitly commits it with
`confirmContactsOnly: true`. Source identities, candidate context, active target
revision and snapshot are rechecked under retained write locks. Changes force a
fresh review; they cannot silently alter the approved attribution.

The atomic commit creates suppliers only for create decisions and saves immutable
source-to-supplier bindings for accepted create/link decisions. A late failure
rolls back the entire batch, including newly created suppliers and its audit
events. Replaying the same committed approval returns its original result and
does not duplicate contacts or source history. Another batch cannot rebind an
already accepted `(source system, source ID)`; explicitly skip it and retain the
original provenance. Historical corrections/merges require a future separately
reviewed process. Refreshing a pending batch retains old immutable approvals and
invalidates its current review/approval.

Current supplier contacts and accepted source/contact snapshots are displayed
separately. Ordinary later phone, email or address corrections leave accepted
history unchanged. The provenance view links only to the original private source
attachment. No automatic customer, supplier, product or accounting matching occurs.

## API and migration

- `GET/POST /api/suppliers` lists/searches or manually creates owner contacts.
- `GET/PATCH /api/suppliers/:id` reads source provenance or updates contacts only.
- `POST /api/suppliers/:id/activation` requires revision, active flag and reason.
- Delete and merge routes are guarded conflicts, not history removal operations.
- `/api/supplier-imports` has template, preview, read, refresh, review, approve,
  commit and source-attachment endpoints.
- Directory pages contain at most 50 records; source batches at most 200 rows.
  Candidate/history limits fail closed with review guidance rather than silently
  dropping an identity. A chosen existing link can be selected from paginated
  directory search even when source contact hints do not match it.
- Only the supplier preview endpoint shares the bounded 3 MiB escaped-JSON parser
  with the archive preview. Its source still has a 1 MiB limit, and other JSON
  endpoints keep their original 1 MiB transport limit.

Migration `0028_supplier_contact_import` follows the complete archive `0026` and
SMS `0027` metadata. It adds four tables and preservation guards; every prior
modeled table definition remains unchanged. This is a separate source batch and
requires normal reviewed integration, backups, migrations and compatible recovery
before deployment. It does not implement active-job, open-purchase-order or
opening-balance migration, or the complete client transition package.

## Verification

The actual app/PostgreSQL fixture uses two disposable local company databases and
legitimate fixture password sessions. It checks owner/preview/CSRF/tenant denial,
manual add/edit/status auditing, retained names, exact source bytes, explicit
review, no-overwrite linking, stale target snapshots, duplicate names/IDs,
concurrent commit replay, competing source claims and late-failure rollback.
All original operational, financial, stock, alias, communications and auth records
are compared unchanged. Every external provider request is blocked. New directory
records and explicit contact/status edits are the only intended active data changes.
