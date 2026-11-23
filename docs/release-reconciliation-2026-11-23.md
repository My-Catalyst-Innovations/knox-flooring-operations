# Knoxville release reconciliation — November 23, 2026

## Source of truth

Daniel approved deployment after speaking with Josh. The deployment candidate starts from Josh's shared branch `codex/knoxville-supplier-preview`, commit `df1403d7ccf8828f654ae7f764fd783c22e7e5a7`. The separate local implementation started from the older `b2bb101` revision. Its complete source is preserved locally in snapshot commit `0a7c81a5e6a5f47bc003cdce6c42de13697c7feb` and in Daniel's original working folder.

The trial merge exposed two different inventory ledgers and different QuickBooks valuation approaches. Deploying both would create conflicting stock and cost authorities. This candidate therefore preserves Josh's current warehouse, purchase orders, physical pieces, stock counts, supplier imports, accounting adapters, workspace isolation, Azure Blob storage, Outlook, SignalWire, staff access, and production authentication. It does not replace these with the older local alternatives.

The local branch's migrations `0007`–`0012` are not applied or renumbered into this release. All deployed migration files through `0019_outlook_mailbox_sender` remain unchanged. This candidate has no new database migration.

## Existing capabilities retained

The current shared application already provides internal SKUs, supplier/manufacturer crosswalks, purchase units, warehouse/bin locations, purchase orders, partial and damaged receipts, receipt-based costing, linked returns, reservations, staging, transfers, physical rolls/remnants, approved counts, and source-backed operational KPIs. Its release tests include the 50-box receipt, 30-box issue and two-box return: 22 boxes and $1,344 net job material cost.

Company workspaces use distinct databases and private file containers. Hands-on practice is isolated into a separate configured deployment; client workspaces expose read-only lessons. The Sales mission validates saved practice records.

## Compatible changes in this candidate

- Training restores only a run matching the current role, yields to business dialogs, resets its panel scroll between steps, and accurately identifies completion with skipped steps. Existing practice restrictions remain intact.
- QuickBooks token refresh is serialized with bounded requests; requests use the saved company environment. OAuth state is bound to its user/session and expiry, and connection changes are transactional.
- Reconciliation uses saved links and does not match unrelated records because both lack an email address or phone number. Imported invoice balances recheck the connected company and mapping before updating local records.
- Actual QuickBooks Projects support is explicitly marked unverified. A legacy subcustomer is not represented as a true Project. Existing known subcustomer references remain preserved.
- Job-attributed warehouse waste posts the associated material cost in the same stock-count transaction. The existing FIFO and price-review behavior is reused, and retries must not create another job charge.

## Verification of this candidate

These results apply to the reconciled candidate based on Josh's current shared branch, not to the older local implementation:

| Check | Verified result |
|---|---|
| API test suite | 215/215 tests passed across 32 files |
| Frontend test suite | 156/156 tests passed across 47 files |
| Focused job material-cost checks | 6/6 passed; included in the API total above |
| Migration checks | 10/10 passed |
| Release checks against real PostgreSQL | 45/45 passed, including backup and restore verification covering 59 tables |
| API build and typecheck | Passed |
| Frontend build and typecheck | Passed |
| Migration changes | None; existing migration files remain unchanged |

Hosted Linux CI and production deployment are still pending. These local results do not establish that the candidate is deployed or that live external integrations have passed acceptance.

## Not included or not yet accepted

- The older local onboarding/configuration package and historical archive are not transplanted into this candidate. Their import adapters depend on the alternative warehouse model and require a separate reconciliation with the current supplier/warehouse entities. Company provisioning and existing reviewed supplier/catalog imports remain available.
- A specific physical roll still lacks a direct acquisition-cost-layer identity. When differently priced rolls share a bin, bin-level FIFO may not represent the selected roll's actual acquisition cost. A future change needs explicit piece-to-cost allocation, additive migration, and handling of ambiguous existing stock; it must not infer missing provenance.
- The current warehouse supports typed and keyboard-scanner input. Camera scanning and physical scanner/printer acceptance remain separate work.
- Real Intuit sandbox reconciliation, Projects entitlement, Microsoft resource authorization, physical-device checks, and bookkeeper approval remain external acceptance requirements. Mocked tests do not establish those connections.
- The original local release is not fully merged merely because equivalent workflows exist in the shared branch. Review this candidate's actual diff and the remaining items above before describing its scope externally.

## Deployment gate

The verified site address is `https://works.mycatalystinnovations.com`. Current repository documentation identifies Azure App Service and private Azure Blob storage. The DigitalOcean instructions in older documents are historical and must not be applied to Azure.

At the initial access check, Daniel's Azure session could see only the Catalyst Scanner Signing subscription, with no App Services. The application resource ID, publishing method, current deployed image, database backup, and recovery path could not be verified from that account. Hosting and deployment access information has been requested from Josh. His App Service link or deployment method is required to continue the live cutover. A passing CI run or a Git push is not proof of deployment.

Before cutover: verify the actual source revision and hosting resources; preserve the deployed image/configuration; check backups and restore capability; run this candidate's CI; deploy through the existing approved mechanism; verify sign-in, permissions, training, inventory, costing, and health at the public address. Do not seed/reset company data, enable new providers, or change accounting valuation during this release.
