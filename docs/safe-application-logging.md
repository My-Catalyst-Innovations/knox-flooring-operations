# Application diagnostics

The API logger emits allowlisted diagnostic codes, known error classes, HTTP
status codes, known PostgreSQL SQLSTATE codes, bounded counters, and static route
classes. It does not emit raw request URLs, identifiers, query strings, headers,
cookies, bodies, provider responses, arbitrary messages, error messages, stacks,
or causes. Unknown log messages become `Application event`.

The Pino boundary sanitizes ordinary records, child bindings, later bindings, and
interpolated arguments before serialization. Child custom serializers, prefixes,
and formatters cannot bypass it. Add diagnostic codes deliberately in
`safe-logging.ts`; never add request or provider values to the allowlist.

The final Express error handler uses generic HTTP errors and closes already
started responses without forwarding raw errors to Express's stderr handler.
This covers malformed JSON and oversized requests as well as route failures.

Diagnostics are separate from stored business evidence, audit history, and API
responses; this change does not rewrite those records or change financial retries.
The authorized workspace-provisioning CLI still prints its explicit invitation
result for its operator. Its error output is sanitized. Treat that command result
as a credential-bearing operator artifact, not an application log.

Two exact internal provisioning refusals retain safe diagnostic codes:
`workspace_existing_records` means an occupied database needs explicit reviewed
adoption, and `workspace_owner_exists` means the existing owner/invitation must
be preserved. Other exception text remains generic; partial message matches do
not authorize an arbitrary string to enter logs.

These safeguards cover application logging and the final HTTP error handler.
They do not claim to sanitize host/platform diagnostics, dependency import-time
failures, or arbitrary process crashes outside those boundaries.
