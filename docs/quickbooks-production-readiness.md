# QuickBooks production preparation

This document records software behavior and remaining review work. It is not an
Intuit submission, an approved customer agreement, or a security certification.
Development credentials can be used for authorized fictional sandbox acceptance
while the production assessment remains pending. No Will data is required for
this preparation.

## Security changes in this slice

API responses receive `no-store, no-cache, must-revalidate`, `Pragma: no-cache`,
an expired cache date and `Referrer-Policy: no-referrer` before authentication,
workspace routing, platform routing or request parsing. The final response also
enforces these headers if a route attempts to replace them. This includes the
single default database. Public static assets retain their existing cache policy.

The QuickBooks callback remains behind the trusted company boundary and cookie
parser. It performs its own normal persisted-session lookup and requires an
actual owner outside role preview. State remains bound to that owner/session,
its requested scopes, expiry, single-use nonce and saved connection lifecycle.
Each result clears the authorization cookie and returns an empty `302` to a
fixed relative Settings destination. Denial, expiry, replay, missing sessions
and provider failures cannot echo provider query data or choose another origin.
A `HEAD` request cannot consume the nonce or exchange an authorization code.
Settings explains the safe result; a query claiming success never establishes
that a company is connected. The saved connection remains authoritative.

Unknown or unavailable company hosts can be refused by the existing workspace
boundary before the callback. This change does not turn them into valid hosts.

Application diagnostics use allowlisted route classes, diagnostic codes, status
and error classes. They omit raw URLs, queries, headers/cookies, provider bodies,
arbitrary error messages/stacks and company identifiers. The final Express error
handler also prevents parser/unhandled errors from reaching its raw stderr
fallback. It returns generic JSON and closes already-started responses without
forwarding their raw error. Approved business/audit records are a separate data
inventory; log sanitization does not delete financial provenance. Azure/edge
access logs, tracing and operator exports require their own configuration review.

## Realm identifier: storage encryption versus field encryption

The [Intuit security requirements](https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app/security-requirements.html)
say: "Encrypt and store the refresh token and realmID in persistent memory."
They do not explicitly specify an additional application-level encrypted realm
column. Intuit's [current support answer](https://help.developer.intuit.com/s/question/0D5TR00001Zm2EA0AZ/production-credential-assessment-serverless-hosting-country-locked-payments-permission-realm-id-encryption-and-browser-sessions)
repeats that requirement without expressly resolving the storage-encryption
question.

[Microsoft's managed PostgreSQL documentation](https://learn.microsoft.com/en-us/azure/postgresql/security/security-data-encryption)
states that Flexible Server always encrypts its stored data, including databases,
WAL, logs and backups. Service-managed keys are the default; customer-managed
keys are an alternative. Its [service overview](https://learn.microsoft.com/en-us/azure/postgresql/overview)
identifies AES-256 storage encryption. A readable SQL `realm_id` column therefore
does **not** establish that the production database stores it unencrypted at
rest. Access/refresh tokens also have application-level AES-256-GCM encryption.

The accurate assessment answer must distinguish these layers and attach current
operator evidence identifying the actual Azure Flexible Server and its key mode.
The current sanitized operator metadata confirms
`Microsoft.DBforPostgreSQL/flexibleServers`, PostgreSQL17 and `SystemManaged`
data encryption for the production server (reviewed2026-11-24UTC). This supports
an encrypted-at-rest statement for that managed database; it is not evidence of
an additional encrypted application column or protection of every exported copy.
Do not assert field encryption exists, that all copies are covered, or that
Intuit has accepted this architecture before it has reviewed it. Local logical
dumps, downloaded exports, application logs and off-service copies need their
own protection and access/retention evidence.

No realm schema or scope-matching change is made in this slice. If field
protection is chosen as added protection or Intuit requests it, first design:

- Versioned authenticated ciphertext and an independently keyed lookup
  fingerprint for exact realm matching; no randomized-ciphertext equality joins.
- An inventory of realm references in connections, mappings, approved payloads,
  exceptions and provenance. Encrypting one column is not complete coverage.
- An additive, reversible application rollout with authenticated backfill,
  preserved historical approvals and exact company/environment binding.
- Key access/rotation/recovery, protected exports and tests for wrong-company
  refusal, reconnect, revocation, concurrent writes and restoration.

This would be a separately reviewed change. It must not weaken owner approval or
allow a changed company to inherit another company's financial authorization.

## Public product pages: draft implementation design

[Intuit's production checklist](https://static.developer.intuit.com/output_html/qbo/docs/go-live/publish-app.html)
requires public policy/application URLs and an approved assessment before
Production credentials. Extra App Marketplace reviews are a separate process.

Provide public, unauthenticated Works privacy, EULA and support pages with
reviewed product-specific content. The marketing site's privacy page describes
website inquiries/analytics; its existing website terms identify themselves as
a placeholder. Neither is evidence of an approved Works agreement. Proposed
product URLs must remain clearly proposed until actual pages are published.

Privacy content needs the actual data inventory/purposes, connected accounting
access, processors and optional AI flows, safeguards, rights/request method,
chosen retention and backup handling. EULA content needs the actual service and
support arrangements, company authority to connect accounts, user approval and
accounting responsibilities, dependency limits and the approved termination
process. Josh must review the real entity/contact details and substantive terms.
Do not invent certifications, response commitments or legal retention periods.

Provide real launch/connect/reconnect/disconnect landing pages. Preserve login
continuation to allowlisted in-app destinations only. A disconnect landing may
receive `realmId`, but query data alone must never revoke a connection or select
another company. Intuit [documents this as a user landing URL](https://help.developer.intuit.com/s/article/Retrieving-the-realmId-from-the-disconnect-URL).
Owner actions continue to use authenticated, CSRF-protected APIs. The page must
distinguish a local stop, pending/unknown revocation and confirmed revocation.

## Retention and erasure: draft operational design

The [Developer Terms](https://static.developer.intuit.com/output_html/qbo/docs/legal-agreements/intuit-terms-of-service-for-intuit-developer-services.html)
require consent-bounded use and cessation after withdrawal, and requested secure
deletion subject to applicable record-keeping obligations. Disconnect currently
stops new connector use and attempts token revocation; it does not erase business
records, uploaded documents, financial history or all backups.

Build a reviewed data-request process before promising automatic deletion:

1. Authenticate the requesting company/authorized person and identify the exact
   requested scope. Public requests cannot execute deletion or select a tenant.
2. Inventory tokens, provider snapshots/IDs, cached records, derived data,
   approvals, queued work, private files, exports, logs and each backup copy.
   Distinguish user-entered accounting records from provider-sourced copies.
3. Record a proposed return/deletion plan with any documented legal hold and
   approved retention matrix. Undefined retention periods remain unresolved.
4. Obtain explicit owner/operator approval outside held database locks. Pause
   affected processing and keep ambiguous provider attempts paused; do not
   duplicate transactions, reverse remote entries or erase accounting evidence.
5. Execute short scoped operations, verify exact affected records and retain a
   minimal protected request/outcome audit. Referential or immutable records
   require a reviewed treatment, not disabled constraints or broad cascades.
6. Track export expiration and backup lifecycle separately. Restores must
   reapply recorded deletion restrictions before customer access or processing.
   Do not claim immediate purge of backups that cannot yet satisfy that promise.

Operator controls, processor agreements, security/incident procedures, assessment
evidence and legal/customer wording remain owner-reviewed requirements. These
drafts do not publish policies, accept legal terms, create credentials, enable
providers or authorize financial posting.
