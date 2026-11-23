# Catalyst Works

Operations, estimating, invoicing, job costing, and approval-based QuickBooks Online synchronization by Catalyst Innovations. Company branding is configured for the workspace and customer documents.

## Secure first-owner setup

The application has no public registration page. On the first production start, it creates the owner from `OWNER_EMAIL`, `OWNER_INITIAL_PASSWORD`, and `OWNER_NAME`. The password must contain at least 12 characters. After a user exists, the bootstrap values are ignored.

From **Settings → Staff access**, an owner can create a one-use password setup link for a named teammate. Share the link privately with that teammate within 48 hours. Deactivating a staff account revokes its active sessions.

For a temporary evaluation environment, set `DEMO_ACCESS_ENABLED=true` to show an audited, password-free owner entry button while retaining the normal sign-in screen. Set it back to `false` before implementation or whenever public demo access should end.

Use `.env.example` to identify the required settings. Store production values in the Catalyst Works App Service environment variables in Azure and keep real credentials out of Git.

## Shared company onboarding

Set `CATALYST_WORKSPACES` to an array of company keys and canonical HTTPS origins to host multiple companies in one app. Each company has its own PostgreSQL database, application database account, private Azure Blob container, and HTTPS hostname on port 443. Register each hostname with App Service and preserve the incoming `Host` header at the proxy. Keep raw request paths and referrer headers out of proxy and App Service access logs because customer links carry private tokens.

```json
[
  { "key": "company-one", "origin": "https://company-one.works.example.com" },
  { "key": "company-two", "origin": "https://company-two.works.example.com" }
]
```

Use a separate environment prefix for each company. For `company-one`, set `CATALYST_COMPANY_ONE_DATABASE_URL`, `CATALYST_COMPANY_ONE_AZURE_STORAGE_ACCOUNT_URL`, and `CATALYST_COMPANY_ONE_AZURE_STORAGE_CONTAINER`. Provider settings such as `CATALYST_COMPANY_ONE_RESEND_API_KEY` use the same prefix. OAuth callbacks and password reset links use the workspace origin. Shared mode ignores unprefixed provider secrets and disables password-free demo sign-in.

1. Migrate each newly provisioned database by running `pnpm --filter @workspace/db migrate` with that database as `DATABASE_URL` and the shared manifest unset.
2. In the trusted deployment environment, set the manifest and per-company variables, build the API, and run `pnpm --filter @workspace/api-server workspace:prepare --workspace company-one --company "Company One" --owner-name "Owner Name" --owner-email owner@example.com`. The command binds the database and prints a one-use owner set-up link. Deliver it privately. It expires in 48 hours.
3. For an existing company, migrate the database first and append `--adopt` to the prepare command. It requires the saved company name and an active owner's email. The first binding clears existing sessions so staff establish new sessions on the hosted workspace.
4. Start the app with the shared manifest. Migrations and startup verify that each database is bound to the configured company. If App Service probes a management hostname, set `CATALYST_WORKSPACE_HEALTH_HOST` to that exact hostname. It serves the health probe. Application routes require a workspace hostname.

## Training and fictional practice

The Training Center on a live workspace provides read-only workflow lessons and contextual Page Guides. To offer guided exercises, run a standalone practice deployment on a separate, access-restricted HTTPS hostname with a new PostgreSQL database, its own user accounts, and a separate private Blob container if uploads are enabled. Use fictional company settings and business records. Production logins remain on the production hostname.

On the practice deployment, set its HTTPS origin as both `APP_BASE_URL` and `PRACTICE_WORKSPACE_URL`. Set `DEMO_MODE=true`, `DEMO_ACCESS_ENABLED=false`, `BACKGROUND_WORKERS_ENABLED=false`, and `COMMS_DELIVERY_MODE=capture`. Leave accounting, calendar, measurement, and messaging provider settings unset. In a live deployment set `PRACTICE_WORKSPACE_URL` to that distinct origin to display a link. In shared company mode, use the company environment prefix for the link. Interactive practice remains disabled in the shared deployment.

The Sales & Estimating Mission checks for a saved fictional lead, a measured estimate, and its converted proposal. Other role missions guide the team through the reference material and screens. Restarting a mission creates a new practice customer name, while previously entered fictional records stay available in the practice workspace.

## Email, texts, and password reset

Verify the sending domain in Resend, including its DNS records for SPF and DKIM. Create a send-only key and set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in App Service. Set `RESEND_REPLY_TO_EMAIL` if replies should go to a different monitored mailbox. [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)

Create a Resend webhook for each workspace at `https://<workspace>/api/communications/email/webhook`. Configure that endpoint's unique signing key as `RESEND_WEBHOOK_SECRET`. Subscribe to `email.sent`, `email.delivered`, `email.failed`, `email.bounced`, `email.complained`, and `email.suppressed`. Permanent bounces, complaints, and provider suppressions block future email to the address in that workspace. A temporary bounce records a delivery failure without adding an address to the local suppression list. [Resend webhook setup](https://resend.com/docs/dashboard/webhooks/introduction)

For company texts, use the SignalWire project that owns the registered, SMS-capable E.164 sender. Set `COMMS_SMS_PROVIDER=signalwire`, `SIGNALWIRE_SPACE_URL` (the HTTPS `*.signalwire.com` Space), `SIGNALWIRE_PROJECT_ID`, a Messaging-scoped `SIGNALWIRE_API_TOKEN`, the project's `SIGNALWIRE_SIGNING_KEY`, `SIGNALWIRE_FROM_NUMBER`, and the workspace's HTTPS `APP_BASE_URL`. On the number's Compatibility API messaging settings, set the incoming message webhook to POST `https://<workspace>/api/communications/webhooks/signalwire/inbound`. Outbound messages include a signed-callback destination for delivery status. Inbound replies appear in communication history. When the phone-number pair identifies one existing lead or customer conversation, the reply also appears on that record. [Send messages](https://signalwire.com/docs/compatibility-api/rest/messages/create-message) · [Messaging webhooks](https://signalwire.com/docs/compatibility-api/cxml/reference/messaging) · [Webhook signing](https://signalwire.com/docs/compatibility-api/guides/webhook-security)

For existing Twilio sends, set `COMMS_SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`. Existing Twilio records retain their history. [Twilio Messaging API](https://www.twilio.com/docs/messaging/api/message-resource)

SignalWire STOP and equivalent commands block future sends from that company number to the same recipient. A subsequent START or UNSTOP restores sending after Catalyst Works verifies the message and its timestamp with SignalWire. The app records these commands in communication history. [SignalWire opt-out responsibilities](https://signalwire.com/docs/platform/messaging/send-and-receive-messages)

When `DEMO_MODE=false`, email keeps its existing policy: `COMMS_DELIVERY_MODE=allowlist` permits approved email addresses in the comma-separated `COMMS_ALLOWLIST`, and `COMMS_DELIVERY_MODE=live` enables delivery to other email recipients.

SMS has separate controls: `COMMS_SMS_DELIVERY_MODE` defaults to `capture` when missing or invalid, even when email is live and SignalWire credentials are configured. To test company texting, explicitly set `COMMS_SMS_DELIVERY_MODE=allowlist` and put consenting internal test numbers in `COMMS_SMS_ALLOWLIST`; this list never inherits email/global entries. An empty or invalid SMS test list disables the company-send button. Set SMS mode to `live` only after approving the dedicated sender, registration, consent process and live acceptance. Existing SMS deployments must set the new SMS policy explicitly to resume provider delivery; global email settings alone no longer activate it.

Both channels remain capture-only in demo mode or with password-free demo access enabled. SMS readiness reports explain capture, missing setup and an empty test list without exposing credentials. Signed SignalWire delivery/inbound callbacks remain active when outbound SMS is paused, so receipts, replies and opt-outs are still recorded. SignalWire `sent` records carrier handoff. Its `delivered` status reflects a carrier receipt, which some carriers do not send. [SignalWire delivery statuses](https://signalwire.com/docs/compatibility-api/rest/messages/webhooks/sms-status-callback)

To allow active staff to request reset links, set `PASSWORD_RESET_EMAIL_ENABLED=true` alongside a configured Resend sender, `DEMO_MODE=false`, and the workspace HTTPS `APP_BASE_URL` (for example, `https://works.mycatalystinnovations.com`). Reset emails use a separate setting from customer delivery. Their links expire after 30 minutes. Keep click and open tracking disabled on the sending domain. [Resend tracking settings](https://resend.com/blog/introducing-custom-tracking-domain)

## File storage on Azure

Enable App Service's system-assigned managed identity and grant it **Storage Blob Data Contributor** on a dedicated private Blob container. Set `AZURE_STORAGE_ACCOUNT_URL` to `https://<account>.blob.core.windows.net` and `AZURE_STORAGE_CONTAINER` to the container name. Keep anonymous Blob access disabled. App Service supplies its identity endpoint and header. The application sends and reads files through the server using that identity. [Managed identity setup](https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity)

Job photos, product images and lead documents stay within the workspace. Select **Share this photo on the customer portal** when adding a photo intended for customers with the job link. A company logo uploaded in **Settings → Customer document branding** is published on customer documents when the owner saves branding. Files can be up to 15 MB. Choose JPEG, PNG, WebP or GIF for inline images.

If you are moving a workspace from Replit, copy existing objects into the private container under their original keys to keep links working. Older job photos remain internal.

## Inventory onboarding

Create your warehouse names under **Inventory → Warehouses**. Download the CSV template under **Inventory → Import products**. Enter each internal SKU as text to preserve leading zeros. If a product has no internal SKU yet, leave that value blank and enter a stable `source_item_id` from your export. Use a separate row for each warehouse with an opening count for that item. Keep the item identifiers, product details, stock unit, and prices the same on those rows. The preview shows the assigned SKUs and flags existing records and rows that need correction.

Use **Preview supplier CSV** to match manufacturer part numbers and supplier SKUs to your internal SKUs. The owner approves each supplier price and its effective date. Use a physical stock count for warehouse balances and the vendor agreement for approved purchase prices.

Create an order under **Inventory → Purchase orders** with the supplier, receiving warehouse, products, and unit costs. The draft fills in the approved supplier price when a single supplier code matches the product and its unit on the current business date. Review the suggested price before ordering. Mark the order **Ordered** after placing it with the supplier. Use **Receive shipment** to record only the items that arrived, with an optional packing slip reference and a destination bin per line. A partial receipt leaves the balance open. Create, inspect, and move bins under **Inventory → Warehouse bins**.

Link a purchase order to a job and add the supplier's delivery estimate. The job workflow shows the linked open quantity and expected date. Use **Stock activity → Pick and stage** to scan a product and move part of an active reservation to a bin or truck. The pick stays reserved for the same job. **Record used** issues the staged stock and adds job cost.

Use **Inventory → Rolls & remnants** to label stocked square-foot pieces, record a full-width cut, move a piece after arrival, and issue or return a measured piece. The label preview includes the SKU, piece ID, dimensions, and current location. Use **Inventory → Warehouse bins → Stock counts** to submit a physical count, damage, or waste for owner review. Review and reconcile each count before it changes stock.

## QuickBooks Online setup

1. Create an app in the Intuit Developer dashboard and enable the `com.intuit.quickbooks.accounting` scope.
2. Add `https://works.mycatalystinnovations.com/api/quickbooks/callback` as the production redirect URI.
3. Add `https://works.mycatalystinnovations.com/api/quickbooks/webhook` as the production webhook URL.
4. Configure the `QUICKBOOKS_*` secrets documented in `.env.example`. Start with `QUICKBOOKS_ENVIRONMENT=sandbox`.
5. Sign in, open Settings, connect the sandbox company, then run **Import & reconcile**. No record is exported until the owner explicitly approves it.

QuickBooks tokens are encrypted with AES-256-GCM. Webhooks are signature checked and deduplicated. A periodic change-data poll checks for missed invoice changes.

Approve the QuickBooks Service items for labor, add-ons, and non-catalog materials under **Settings → QuickBooks** before exporting invoices with those lines. Production vendor bill export starts disabled. For a verified USD company and item-only vendor bills, set `QUICKBOOKS_PRODUCTION_VENDOR_BILLS_ENABLED=true` and `QUICKBOOKS_PRODUCTION_VENDOR_BILLS_REALM_ID` to the connected production company ID. Each live bill requires owner confirmation after reviewing its matched items and totals.

In **Settings → QuickBooks → Inventory reconciliation**, compare Catalyst's total company stock, including transfers in transit, with the mapped item's current QuickBooks quantity. The comparison shows unmatched items and quantity differences. For stock items Catalyst created with a zero opening quantity, the owner can review a return that explains the full difference. All issues for the job and SKU must trace to accepted receipts on one purchase order and total the item quantity on the posted customer invoice. The posted supplier bill must match the quantity at each price across every accepted receipt for that SKU on the order, including stock the job did not use. The owner approves the adjustment date and account. The adjustment records the return in QuickBooks without changing the warehouse ledger or customer invoice. Jobs with multiple returns, orders, or supplier bills require review in QuickBooks. This uses the primary QuickBooks site for supported US Plus and Advanced companies. Production posting requires `QUICKBOOKS_PRODUCTION_INVENTORY_ADJUSTMENTS_ENABLED=true` and `QUICKBOOKS_PRODUCTION_INVENTORY_ADJUSTMENTS_REALM_ID` to match the connected company. After an unconfirmed submission the app only checks for the previously approved adjustment. [Intuit inventory adjustments](https://static.developer.intuit.com/output_html/qbo/docs/workflows/manage-inventory/inventory-adjustment.html)

Supplier bill review accepts CSV and tab-separated line tables. Inspect the parsed SKU, quantity, unit, and rate before applying the rows. Enter the total shown on the source bill independently so review can flag discrepancies.

Invoices with tax, a fixed discount, an applied deposit, or an existing payment use **Review invoice accounting** in the approval queue. This review also works with an authorized Intuit sandbox when `DEMO_MODE=false` and `QUICKBOOKS_ENVIRONMENT=sandbox`; the displayed company and sandbox label identify the destination. Select and verify the tax code, taxable lines, and discount account before approving. Deposits and existing payments require an exactly matching invoice already recorded in QuickBooks, and the review links that invoice without creating a cash entry. Automated Sales Tax also requires reconciliation to an existing matching invoice. Production reviews remain disabled unless `QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_ENABLED=true` and `QUICKBOOKS_PRODUCTION_REVIEWED_INVOICES_REALM_ID` matches the connected production company. Generic approval cannot bypass accounting review in either environment.

Ordinary individual time and distinct receipt-backed job expenses now have a dedicated owner accounting review. Production starts disabled behind `QUICKBOOKS_PRODUCTION_JOB_COSTS_ENABLED` and an exact realm pin; unknown results use read-only reconciliation rather than another financial submission. See [labor and expense setup, accounting boundaries and verification](docs/quickbooks-job-costs.md).

## Microsoft Outlook setup

1. In the Catalyst Works Outlook Microsoft Entra **Web** application, use `https://works.mycatalystinnovations.com/api/calendar/outlook/callback` as the production callback. Use that exact URL in `OUTLOOK_REDIRECT_URI`. Set `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID`, and a separate random `OUTLOOK_ENCRYPTION_KEY` in the deployment environment. [Authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
2. Grant delegated `User.Read` and `Calendars.ReadWrite.Shared` for a work account. In Outlook, accept any shared calendar invitation and verify calendar editing is allowed. For a personal Microsoft account use `OUTLOOK_TENANT_ID=consumers` and delegated `Calendars.ReadWrite`. The connection also requests `offline_access` so Catalyst can refresh authorization. [Microsoft calendar permissions](https://learn.microsoft.com/en-us/graph/outlook-create-event-in-shared-delegated-calendar)
3. Apply database migrations, enable background workers, then connect from **Settings → Microsoft Outlook** as the workspace owner and choose a writable calendar. Book one installation on a dedicated test calendar, reschedule it, and cancel it. The Outlook event follows the Catalyst booking and contains the job number and crew. Changes belong in Catalyst Works.
4. Use **Publish existing upcoming bookings** when that calendar is ready for the rollout. New bookings use the selected calendar. Previously linked bookings stay in their original calendar. Settings shows sync failures and retries.
5. To send customer emails from the connected Microsoft mailbox, choose **Enable Outlook email** and approve the additional delegated `Mail.Send` permission. Calendar access works without granting email permission. In the email composer, explicitly choose the Outlook mailbox under **Send using**. The company email service remains the default sender and handles password resets. Catalyst does not request inbox read access. Microsoft accepts an email for processing before delivery is confirmed, so Catalyst displays **Submitted to Outlook**. Check Outlook Sent Items and the recipient inbox during an internal test. If submission is unconfirmed, check Sent Items before preparing a new message. [Microsoft email sending](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)

## Verification

```sh
pnpm typecheck:libs
pnpm --filter @workspace/knox-flooring typecheck
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/knox-flooring build
pnpm --filter @workspace/api-server build
```

The container applies versioned SQL migrations under an exclusive database lock before starting the server. Startup never inserts demo records or rewrites historical dates. The readiness endpoint requires a reachable database at the expected migration version.

See [the release and recovery runbook](docs/catalyst-release.md) for backup verification, migration rehearsal, deployment and rollback. Initialize a new isolated demo explicitly with `DEMO_MODE=true ALLOW_DEMO_SEED=true pnpm --filter @workspace/api-server seed:demo` after migrations and the API build. This command refuses an occupied workspace.
