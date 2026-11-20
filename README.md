# Catalyst Works

Operations, estimating, invoicing, job costing, and approval-based QuickBooks Online synchronization by Catalyst Innovations. Company branding is configured for the workspace and customer documents.

## Secure first-owner setup

The application has no public registration page. On the first production start, it creates the owner from `OWNER_EMAIL`, `OWNER_INITIAL_PASSWORD`, and `OWNER_NAME`. The password must contain at least 12 characters. After a user exists, the bootstrap values are ignored.

From **Settings → Staff access**, an owner can create a one-use password setup link for a named teammate. Share the link privately with that teammate within 48 hours. Deactivating a staff account revokes its active sessions.

For a temporary evaluation environment, set `DEMO_ACCESS_ENABLED=true` to show an audited, password-free owner entry button while retaining the normal sign-in screen. Set it back to `false` before implementation or whenever public demo access should end.

Use `.env.example` to identify the required settings. Store production values in the Catalyst Works App Service environment variables in Azure and keep real credentials out of Git.

## Email, texts, and password reset

Verify the sending domain in Resend, including its DNS records for SPF and DKIM. Create a send-only key and set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in App Service. Set `RESEND_REPLY_TO_EMAIL` if replies should go to a different monitored mailbox. [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction)

For texts, enable the sender for your destination and traffic type in Twilio. Set `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`. [Twilio Messaging API](https://www.twilio.com/docs/messaging/api/message-resource)

When `DEMO_MODE=false`, `COMMS_DELIVERY_MODE=allowlist` permits sends to approved addresses and phone numbers in the comma-separated `COMMS_ALLOWLIST`. `COMMS_DELIVERY_MODE=live` enables delivery to other recipients. Choose `capture` to keep messages in the Demo Outbox, which is also the behavior in demo mode. In communication history, a provider's queued or sent status indicates its response to the submission. Later delivery receipts aren't tracked.

To allow active staff to request reset links, set `PASSWORD_RESET_EMAIL_ENABLED=true` alongside a configured Resend sender, `DEMO_MODE=false`, and the workspace HTTPS `APP_BASE_URL` (for example, `https://works.mycatalystinnovations.com`). Reset emails use a separate setting from customer delivery. Their links expire after 30 minutes. Keep click and open tracking disabled on the sending domain. [Resend tracking settings](https://resend.com/blog/introducing-custom-tracking-domain)

## File storage on Azure

Enable App Service's system-assigned managed identity and grant it **Storage Blob Data Contributor** on a dedicated private Blob container. Set `AZURE_STORAGE_ACCOUNT_URL` to `https://<account>.blob.core.windows.net` and `AZURE_STORAGE_CONTAINER` to the container name. Keep anonymous Blob access disabled. App Service supplies its identity endpoint and header. The application sends and reads files through the server using that identity. [Managed identity setup](https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity)

Job photos, product images and lead documents stay within the workspace. Select **Share this photo on the customer portal** when adding a photo intended for customers with the job link. A company logo uploaded in **Settings → Customer document branding** is published on customer documents when the owner saves branding. Files can be up to 15 MB. Choose JPEG, PNG, WebP or GIF for inline images.

If you are moving a workspace from Replit, copy existing objects into the private container under their original keys to keep links working. Older job photos remain internal.

## Inventory onboarding

Create your warehouse names under **Inventory → Warehouses**. Download the CSV template under **Inventory → Import products**. Enter each internal SKU as text to preserve leading zeros. If a product has no internal SKU yet, leave that value blank and enter a stable `source_item_id` from your export. Use a separate row for each warehouse with an opening count for that item. Keep the item identifiers, product details, stock unit, and prices the same on those rows. The preview shows the assigned SKUs and flags existing records and rows that need correction.

Use **Preview supplier CSV** to match manufacturer part numbers and supplier SKUs to your internal SKUs. The owner approves each supplier price and its effective date. Use a physical stock count for warehouse balances and the vendor agreement for approved purchase prices.

Create an order under **Inventory → Purchase orders** with the supplier, receiving warehouse, products, and unit costs. The draft fills in the approved supplier price when a single supplier code matches the product and its unit on the current business date. Review the suggested price before ordering. Mark the order **Ordered** after placing it with the supplier. Use **Receive shipment** to record only the items that arrived, with an optional packing slip reference and a destination bin per line. A partial receipt leaves the balance open. Create, inspect, and move bins under **Inventory → Warehouse bins**.

## QuickBooks Online setup

1. Create an app in the Intuit Developer dashboard and enable the `com.intuit.quickbooks.accounting` scope.
2. Add `https://works.mycatalystinnovations.com/api/quickbooks/callback` as the production redirect URI.
3. Add `https://works.mycatalystinnovations.com/api/quickbooks/webhook` as the production webhook URL.
4. Configure the `QUICKBOOKS_*` secrets documented in `.env.example`. Start with `QUICKBOOKS_ENVIRONMENT=sandbox`.
5. Sign in, open Settings, connect the sandbox company, then run **Import & reconcile**. No record is exported until the owner explicitly approves it.

QuickBooks tokens are encrypted with AES-256-GCM. Webhooks are signature checked and deduplicated. A periodic change-data poll checks for missed invoice changes.

Approve the QuickBooks Service items for labor, add-ons, and non-catalog materials under **Settings → QuickBooks** before exporting invoices with those lines. Production vendor bill export starts disabled. For a verified USD company and item-only vendor bills, set `QUICKBOOKS_PRODUCTION_VENDOR_BILLS_ENABLED=true` and `QUICKBOOKS_PRODUCTION_VENDOR_BILLS_REALM_ID` to the connected production company ID. Each live bill requires owner confirmation after reviewing its matched items and totals.

## Outlook Calendar setup

1. In the Catalyst Works Outlook Microsoft Entra **Web** application, use `https://works.mycatalystinnovations.com/api/calendar/outlook/callback` as the production callback. Use that exact URL in `OUTLOOK_REDIRECT_URI`. Set `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID`, and a separate random `OUTLOOK_ENCRYPTION_KEY` in the deployment environment. [Authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
2. Grant delegated `User.Read` and `Calendars.ReadWrite.Shared` for a work account. In Outlook, accept any shared calendar invitation and verify calendar editing is allowed. For a personal Microsoft account use `OUTLOOK_TENANT_ID=consumers` and delegated `Calendars.ReadWrite`. The connection also requests `offline_access` so Catalyst can refresh authorization. [Microsoft calendar permissions](https://learn.microsoft.com/en-us/graph/outlook-create-event-in-shared-delegated-calendar)
3. Apply database migrations, enable background workers, then connect from **Settings → Outlook Calendar** as the workspace owner and choose a writable calendar. Book one installation on a dedicated test calendar, reschedule it, and cancel it. The Outlook event follows the Catalyst booking and contains the job number and crew. Changes belong in Catalyst Works.
4. Use **Publish existing upcoming bookings** when that calendar is ready for the rollout. New bookings use the selected calendar. Previously linked bookings stay in their original calendar. Settings shows sync failures and retries.

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
