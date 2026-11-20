# Catalyst Works

Operations, estimating, invoicing, job costing, and approval-based QuickBooks Online synchronization by Catalyst Innovations. Company branding is configured for the workspace and customer documents.

## Secure first-owner setup

The application has no public registration page. On the first production start, it creates the owner from `OWNER_EMAIL`, `OWNER_INITIAL_PASSWORD`, and `OWNER_NAME`. The password must contain at least 12 characters. After a user exists, the bootstrap values are ignored.

For a temporary evaluation environment, set `DEMO_ACCESS_ENABLED=true` to show an audited, password-free owner entry button while retaining the normal sign-in screen. Set it back to `false` before implementation or whenever public demo access should end.

Copy `.env.example` into your local secret manager and never commit real credentials. Production values belong in DigitalOcean encrypted environment variables.

## QuickBooks Online setup

1. Create an app in the Intuit Developer dashboard and enable the `com.intuit.quickbooks.accounting` scope.
2. Add `https://knox-flooring-operations-gf5x3.ondigitalocean.app/api/quickbooks/callback` as the production redirect URI.
3. Add `https://knox-flooring-operations-gf5x3.ondigitalocean.app/api/quickbooks/webhook` as the webhook URL.
4. Configure the `QUICKBOOKS_*` secrets documented in `.env.example`. Start with `QUICKBOOKS_ENVIRONMENT=sandbox`.
5. Sign in, open Settings, connect the sandbox company, then run **Import & reconcile**. No record is exported until the owner explicitly approves it.

QuickBooks tokens are encrypted with AES-256-GCM. Webhooks are signature checked and deduplicated. A five-minute change-data poll recovers missed invoice and payment events.

## Outlook Calendar setup

1. Register a Microsoft Entra **Web** application and register the exact callback URL in `OUTLOOK_REDIRECT_URI`. Set `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID`, and a separate random `OUTLOOK_ENCRYPTION_KEY` in the deployment environment. [Authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
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
