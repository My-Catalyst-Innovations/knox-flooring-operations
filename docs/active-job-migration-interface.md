# Active-job migration interface

The actual owner outside role preview can open **Import active jobs** from Jobs
or the navigation. Opening a guide, selecting a saved batch, and viewing cutover
state do not create business records.

Use the header-only template or paste source CSV/TSV. File input reads strict UTF-8
and preserves BOM, CRLF, and leading-zero IDs; pasted text preserves the text the
browser supplies (a browser textarea normalizes line endings). Preview is saved
before any customer, site, existing-job, flooring, safe entry-stage, or source-date
decision is approved. No target is guessed. Customer/job selectors are bounded;
narrow the search when more matches exist. Saved reviews require a fresh explicit
confirmation before approval and again before committing. Editing a decision
invalidates its approval controls.

New import-created jobs retain source status and dates as provenance. They start
with unknown finances and unverified operational readiness. Linking an existing
native job adds only provenance and leaves its values and eligibility unchanged.
Closed history belongs in the separate read-only archive.

Each imported job exposes three separate evidence reviews:

- Operational readiness checks existing real records. No calendar booking,
  receiving, stock or completion evidence is inferred from the source status.
- Full-job forecast requires explicit exact-cent revenue and each cost component,
  plus retained same-job evidence. A current reviewed forecast may enter forecast
  reports. Explicit reviewed zero is valid; blank and stale values are unknown.
- Remaining billing permission is a separate gross ceiling after **all** legacy
  invoices, including unpaid invoices. It is never treated as total contract
  revenue, a receivable, a payment or profit. Draft consumption is retained; voids
  and refunds do not silently restore permission. Zero permission does not mean
  the job is paid.

Evidence must already exist in Job files. Owner review, immutable approval and
application are separate clicks. Changes to the job, source or evidence can make
a review stale; the server revalidates each transition. The UI displays the saved
payload and blocks stale approvals. Unknown outcomes require reloading the saved
state or replaying the exact approved operation rather than inventing a new one.

Imported full-job actual profit and commissions remain unreconciled and excluded.
New Works-recorded labor, material and receipt costs remain separately visible.
They do not supply missing historical actuals. Report notices show excluded job
counts; reviewed full-job forecasts never use the remaining billing ceiling.

Imported invoices start as unpaid Drafts with explicit remaining-work lines. The
editor does not prefill the full contract or permit legacy deposit credits. It
  sends a stable request UUID and current cutover revision; uncertain create results
  freeze the exact request for replay. A proven API rejection unlocks the input for
  current-state review and a new request; retained-identity conflicts remain paused
  for inspection. Editable Draft changes also require the saved
invoice financial fingerprint. Provider-approved/submitted or non-Draft financial
edits remain server-guarded. Imported-job quote conversion is paused in this UI;
use the reviewed remaining-work invoice form instead.

This interface imports operational jobs only. It does not import legacy balances,
payments, historical actual-cost baselines, payroll or commissions, and it does
not connect to a source provider. Correct customer/site masters and retained
evidence documents are genuine implementation inputs. No customer records or
fictional examples are seeded by this feature.
