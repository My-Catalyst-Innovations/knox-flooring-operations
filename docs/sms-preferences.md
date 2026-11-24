# Operational text preferences

Works records evidence and preferences for individual operational texts. It does
not establish legal compliance, register a carrier campaign or verify delivery.
The feature does not send messages when evidence or an opt-out is recorded.

Office staff can open **Text preferences**, look up an exact phone number, and
record an opt-out with a note. Owners, sales staff and operations staff can
suppress recipients. Only the actual owner outside role preview can record
positive evidence or explicitly release an opt-out. Installers have no access.
Server transactions recheck the persisted actor role; a concurrent demotion
cannot make an earlier owner request authorize a positive change.

Evidence records its source, actual past time, note, optional reference, actor,
recording time and whether it is fictional. Fictional evidence is marked and
never permits provider sends, including allowlisted sends. Evidence recorded
without a configured fixed sender remains unbound. The owner must explicitly
review it after configuring the sender; it never becomes permission automatically.
No permission comes from a customer import, customer merge, historical START,
saved phone number or captured message.

Positive evidence is bound to the actual company database/workspace, canonical
company origin, provider, account/project, provider host and fixed sender number.
Changing any of those connection identities requires a new owner review. Token
rotation alone does not change that identity. A Twilio Messaging Service without
a fixed sender is outside this exact-sender consent feature. SignalWire remains
the preferred provider.

Suppression belongs to the normalized recipient within the company database.
It survives changes to hostname, sender, provider or project. A stale office
opt-out still blocks that exact recipient; supplied and actual revisions are
retained. Positive reviews and releases require the exact current revision and
sender fingerprint. A release additionally requires new real evidence later
than the latest recorded negative evidence and an explicit owner release action.

## Signed inbound messages and upgrades

The existing exact-project, sender and callback-signature checks remain in place.
A signed STOP creates immutable negative evidence immediately, before the optional
provider timestamp lookup. A lookup failure cannot lift suppression. Signed
START/UNSTOP records an opt-in request for owner review; it cannot supply initial
permission or silently undo a manual or signed opt-out. Callback replay appends
no duplicate event and cannot erase a later negative preference.

Migration0027 retains existing signed SignalWire STOP and pending-STOP records
without changing the original messages. A later pre-upgrade START does not create
new permission. Recipient lookups, owner review and dispatch also reconcile any
retained negative message that lacks a preference row/event, across old senders
and projects. That read-through repair may append negative local audit history;
it never calls a provider, guesses a positive grant, or changes stock, accounting
or export queues. More than1000 unreconciled negative messages for one recipient
fail closed for explicit review. The database prevents evidence updates/deletion
and validates recipient/evidence links and explicit suppression releases.

## Dispatch and device actions

Both live and allowlisted provider submissions need valid real evidence for the
current binding. The dispatch claim is serialized with preference changes and
saves the permission event, binding fingerprint and revision on the actual
communication. The sender rechecks them immediately before calling the provider.
A committed opt-out blocks every new dispatch claim. A provider request already
in flight cannot be recalled. Unknown submissions retain their original durable
claim and are never blindly retried with the same idempotency key.

Demo, capture and SMS role-preview actions remain capture-only. Role preview does
not change email policy. Device sharing, copying and addressed Messages shortcuts
are disabled for a known company opt-out and unavailable while the preference
cannot be checked. Other device actions remain manual: Works does not know which
app, recipient or personal sender is ultimately chosen and does not record
delivery or grant permission from a share action.

## Provider acceptance still required

SignalWire's current [send/receive documentation](https://signalwire.com/docs/platform/messaging/send-and-receive-messages)
assigns opt-out handling to the application. Its [signed opt-out recipe](https://signalwire.com/developers/demos/r/handle-opt-outs-yourself.html)
shows separate authenticated inbound handling and outbound checks; that example's
automatic confirmations are not enabled by this slice. SignalWire's
[messaging setup guide](https://signalwire.com/docs/platform/messaging) describes
number enablement, registration and trial restrictions. Provider and network
behavior must be verified for the actual number and campaign before activation.

This slice adds no automatic HELP, STOP or START responses, so it cannot duplicate
an existing provider/network responder. The actual company's response ownership,
approved wording and one-confirmation behavior remain an activation acceptance
task. No numbers, campaigns, credentials, tokens or paid services are created.
Automatic reminders, bulk marketing, campaigns and MMS sending are outside this
bounded feature.

## Verification

Pure rule tests cover exact binding changes, missing/unbound/fictional evidence,
calendar/time validity and release rules. Actual PostgreSQL tests exercise the
additive migration and old-column/row/ledger preservation, actual tenant routing,
normal password sessions/CSRF/roles, concurrent review/replay, retained legacy
STOP, signed callback replay, immediate pending STOP, immutable history, changed
actor roles, dispatch revision recheck and unknown provider outcomes. All
provider I/O in those fixtures is replaced by a strict local mock. They do not
record real consent, submit texts or prove live provider acceptance.
