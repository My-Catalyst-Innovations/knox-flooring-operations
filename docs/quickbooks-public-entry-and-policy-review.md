# QuickBooks entry pages and operator policy review

These are source capabilities, not an Intuit production approval, provider acceptance,
legal review or a published policy. No new OAuth scope, grant, company selection,
credential or database migration is introduced.

## Product URLs

The proposed production host is `https://works.mycatalystinnovations.com`:

| Purpose | Path | Behavior |
| --- | --- | --- |
| Launch | `/integrations/quickbooks/launch` | Explain the connection and open the authenticated workspace |
| Connect | `/integrations/quickbooks/connect` | Owner-initiated existing OAuth flow |
| Reconnect | `/integrations/quickbooks/reconnect` | Owner-initiated existing OAuth flow after unresolved revocation is cleared |
| Disconnect | `/integrations/quickbooks/disconnect` | Owner reviews saved local state and explicitly requests existing CSRF-protected revocation |
| Help/support instructions | `/help/quickbooks` | Public instructions without a fabricated support address or provider approval claim |
| Privacy | `/privacy` | 503 until its complete exact version is operator approved in deployment configuration |
| EULA | `/terms` | Independently503 until its complete exact version is operator approved in deployment configuration |
| Existing OAuth callback | `/api/quickbooks/callback` | Existing saved-session/state/lifecycle checks and empty safe302 results |

Query-bearing entry/help/policy requests receive an empty302 to a fixed clean path.
Company IDs, codes and state are never reflected or used by an entry page to choose
or revoke a connection. Encoded/case/trailing variants are canonicalized; unknown
QuickBooks entry subpaths return an empty404. Public GETs never disconnect, connect
or accept legal terms. Unknown hosts remain subject to the trusted workspace boundary.

Login continuation accepts only four `continue=quickbooks_<intent>` values mapped
to fixed local paths. An external URL, arbitrary internal path, duplicate or malformed
value falls back to the dashboard. No browser storage chooses a company.

`GET /api/quickbooks/entry-status` is limited to the actual owner outside role preview.
It reads the selected company database and accepts no query selectors. Its safe DTO
contains configuration state, company display name/environment, actual local-use stop,
and the saved pending/unknown/failed/confirmed revocation result. It exposes no realm
ID, connection identifier, token or provider response. No provider read is needed.
Only explicit controls invoke the existing connection and CSRF disconnect APIs.

A saved local stop without a recorded provider outcome is `not_requested`, not
confirmed revocation. The global OAuth-start, callback and replacement guards now
block that legacy case as well as pending/unknown/failed outcomes. An explicit
same-grant retry is available only when the retained refresh token can be decrypted,
has not already been erased, and the required client configuration exists. No
implicit retry is made. Missing or unreadable grants remain stopped for operator
review; this feature cannot prove revocation of a grant whose original token was
already lost. There is no manual "mark provider confirmed" shortcut. Only an actual
confirmed revocation response clears retained credentials in the existing flow.

## Policy draft and approval boundary

The internal templates live in `artifacts/api-server/src/lib/product-policies.ts`.
They are not imported by the frontend or served as draft content. Unapproved public
pages contain only a503 unavailability notice. Draft wording describes actual CRM,
inventory, purchasing, jobs, documents, accounting review, source/audit history,
optional integrations, capture/device sharing, and disconnect-versus-deletion behavior.
It does not invent a legal entity, jurisdiction, retention duration, certification,
support address or SLA. Fees and services remain subject to private quotes/orders.

Complete the public fields in `docs/policy-public-fields.example.json` locally. Review
actual enabled processors, locations and privacy responsibilities, not just the list
of available connectors. Current code has no automatic erasure executor; retention,
backup deletion and request-handling commitments require an actual operator process.
Do not approve wording promising automation that has not been built and verified.

After a normal API build, generate the structured internal review packet:

```powershell
node artifacts/api-server/dist/policy-review.mjs
node artifacts/api-server/dist/policy-review.mjs --fields-file C:/approved-local/public-fields.json
```

The first command explicitly lists unresolved decisions. The optional fields file
contains intended public wording only. The CLI never reads deployment credentials,
accepts terms, submits an assessment, changes settings or publishes a document.
Its packet includes rendered canonical text, unresolved fields, version and SHA-256
of the exact UTF-8 text. Its draft status is not an approval. Store/review that packet
through the company's appropriate legal/security process.

Only the deployment operator can later supply `WORKS_LEGAL_PUBLICATION_JSON`:

```json
{
  "publicationVersion": 1,
  "fields": {},
  "documents": {
    "privacy": { "approved": false, "version": "2026-11-23.1", "contentSha256": "REVIEW_REQUIRED", "approvedBy": "", "approvedAt": "" },
    "terms": { "approved": false, "version": "2026-11-23.1", "contentSha256": "REVIEW_REQUIRED", "approvedBy": "", "approvedAt": "" }
  }
}
```

This example intentionally cannot publish. Approval requires every document's required
field to contain reviewed public wording, its exact bundled version and generated
content hash, explicit approval, reviewer and nonfuture timestamp. A changed included
field or template invalidates the old hash. Approval of one document never publishes
the other. The SHA covers the canonical text shown by the packet, not presentation
CSS. Public approved pages escape all field values and load no third-party resources.

The gate reads the process deployment setting, not tenant settings, tenant environment
overrides, request parameters, headers or authenticated owner input. There is no owner
publication API. No deployment configuration is changed by this source work.

## Remaining operator acceptance

Intuit requires production app details including policy/EULA and launch/disconnect/
connect URLs and an approved App Assessment before production credentials are shown.
Sandbox connection, disconnection and reconnection must still be exercised with the
real owner/provider. These pages do not complete those steps. The separate readiness
packet's identity, practices, testing and security attestations remain owner decisions.
Product erasure/retention automation and legal acceptance recording are outside this
bounded slice and are not represented as implemented.

Primary sources, checked2026-11-23:

- [Intuit production app setup](https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app.html)
- [Intuit security requirements](https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app/security-requirements.html)

The security page explicitly concerns App Store review requirements. It also documents
safe redirects for token/customer-identifying query endpoints; no broader certification
claim is inferred from implementing those controls.
