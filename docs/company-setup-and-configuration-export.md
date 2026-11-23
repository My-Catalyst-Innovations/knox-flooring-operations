# Owner setup and company configuration export

This first onboarding slice adds an owner-only setup view and a versioned export of
supported company settings. It does not implement Daniel's broader active-record
migration, historical archive, configuration import, restore, or a second ledger.
Private quotes and named invitations remain the onboarding policy. This feature
does not enable signup or checkout and sends no invitations.

## Setup view

Settings shows Company setup only to an actual owner outside role preview.
GET /api/company-setup/readiness reads the currently selected company's saved
settings and provider state. It never refreshes tokens, probes providers, sends
messages, copies files, posts accounting records, or inserts default settings.

Steps distinguish saved business identity, an explicitly reviewed pricing policy,
saved closeout policy, warehouse/bin coverage, server configuration, saved account
authorization and saved file target. Saved credentials alone cannot complete an
account-connection step. Capture-only delivery remains incomplete.
An explicitly reviewed zero labor rate is preserved; null or absent rates are not
treated as zero. Supported sparse policy dictionaries remain sparse.
Saved Outlook mailbox authorization is separate from calendar selection and the
Resend company/system email service. QuickBooks saved authorization requires the
Accounting scope, configured environment match and unexpired refresh grant;
encrypted token values are not loaded or opened for this check.

Catalog counts can include mock products, so they do not prove actual inventory
or negotiated-price acceptance. Provider acceptance is always shown as pending:
this slice has no persisted acceptance ledger. It must not claim the client is
ready based on connection metadata, mocked provider tests, or external notes.

## Export contract

GET /api/company-setup/configuration-export returns an authenticated, no-store
JSON attachment named catalyst-works-company-configuration-v1.json:

- format: catalyst-works-company-configuration
- schemaVersion: 1
- exportedAt: an ISO timestamp
- configuration: the whitelist below
- omissions: explicit unsupported/excluded sections
- restoreSupported: false

Included settings are business name/contact/address/website, accent color,
lead-stage names, legacy labor defaults, waste factor, standard-category estimate
policy, commission defaults and installation/closeout policy. A company contact is
business profile configuration, not an exported customer/vendor or user record.

The export excludes users, owner identity, invitations, customer/vendor records,
catalogs, warehouse records, opening stock, movements, jobs, quotes, invoices,
payments, provider transactions and history. It also excludes provider IDs,
mappings, account/realm/calendar/folder identifiers, tokens, secrets, environment
values, storage URLs and logo assets. Private/provider URLs are not portable.

Only the standard estimate categories supported by version 1 are included. A
generic omission notice identifies the presence of custom categories without
exporting their names. Nested unrecognized JSON keys are never serialized.
Invalid supported numeric values, unsafe website URLs or obvious credentials in
text cause export refusal rather than partial output.

The export endpoint queries a whitelist of columns from the selected tenant's
single settings row. It never queries connection, user or business-record tables.
No client-supplied company/workspace selector is accepted. Authentication, actual
owner role, role-preview refusal and the existing host/database tenant boundary
apply to both endpoints. Version 1 introduces no database migration.

## Verification

Pure tests cover whitelist exclusions, malicious nested data, unsupported custom
keys, invalid values, reviewed-policy conditions and configuration versus actual
acceptance. UI tests cover owner/preview access, missing consent, refresh, failed
readiness and authenticated file download.

The real PostgreSQL release workflow tests unauthenticated/staff/preview refusal,
no implicit settings insertion, strict export content/headers and unchanged
database snapshots. Its two-host fixture verifies separate-company exports,
cross-company cookie refusal, unknown hosts, rejected company selectors, and
tenant-specific provider configuration.
