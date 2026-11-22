# Catalyst Works readiness audit

Reviewed November 22, 2026 against Daniel's November 19 email, the repository, the live deployment, and the requested Knoxville workflows.

Earlier reporting overstated completion. This audit identified and addressed missing device sharing, SignalWire receipts and replies, training isolation, report source records, and QuickBooks stock reconciliation.

| Area | Implemented behavior | Connection and verification |
| --- | --- | --- |
| Product identity | Permanent internal SKUs, manufacturer and supplier aliases, approved dated prices, purchase-to-stock unit conversions | Fictional import and supplier bill verified, including leading-zero SKU and independent source total |
| Warehouses | Warehouse and bin lookup, purchase orders, partial and damaged receipts, transfers, reservations, staged picks, labeled rolls and remnants | Real PostgreSQL workflow and protected browser checks passed |
| Job costing | Receipt-based stock costs, actual labor and other costs, return reversals, provisional margins when inputs are incomplete | The 50-box purchase, 30-box issue, two-box return reconciles to 22 boxes and $1,344 in job material costs |
| Workflow | Job board and list, installation bookings, readiness checks, work orders, customer quote and invoice links | Internal end-to-end workflow verified |
| Reports | Operational KPIs with exact invoice, job, stock-count, and SKU/location records behind the reported values | Database classification and browser drilldowns verified |
| Device texting | Editable message, device share, addressed Messages link, copy fallback | Browser handoff tested with an emulated share target. Physical phone/tablet confirmation remains |
| Company texting | SignalWire sends, signed delivery events, incoming replies, unassigned-message inbox, STOP and verified START handling | Implementation tested with provider mocks. A SignalWire project, messaging number, and credentials remain to be connected |
| Email | Dedicated verified Catalyst sender, signed receipts, permanent-bounce and complaint suppression, duplicate protection | Live application delivery reached the owner's company inbox. Production delivery and password-reset delivery were explicitly approved |
| QuickBooks | Product mapping, reviewed stock-item creation, supplier bills, invoices, fixed discounts, supported tax, existing-deposit verification, quantity comparison and reviewed return correction | Provider behavior tested with mocks. An authorized Intuit sandbox/company connection remains |
| Outlook | Application configuration, mailbox authorization flow, calendar selection, booking creation/update/cancellation and retry processing | Entra application configured. Mailbox authorization and a real calendar transaction remain |
| Training | Read-only lessons in the client workspace, separately configured practice deployment, persisted outcome checks for the Sales mission | Hosted practice test rejected fabricated clicks and skipped checkpoints, then verified a saved lead, measured estimate and converted proposal |
| Company isolation | Separate databases and private file containers, company-specific integration settings, one-use owner onboarding | Two-company database and session isolation verified. The live client deployment currently hosts Knoxville |
| Optional services | AI assistance, generated narration, measurement imports and Google Calendar adapters | Provider credentials are unconfigured. Core estimates use the application's pricing engine, and Outlook is the primary calendar integration |

The QuickBooks return correction covers app-created zero-opening inventory items where receipts on one purchase order, a posted supplier bill, traceable job issues and one linked return, and a matching posted invoice explain the entire quantity difference. It requires a supported US Plus or Advanced company, an explicitly reviewed adjustment account, and matching production enablement. Cases spanning orders, bills, or multiple returns remain visible for accounting review. Unconfirmed submissions are reconciled through documented read operations without another adjustment POST.

The fictional Juniper Ridge Flooring company lives in the protected validation deployment with its own database and file container. It contains the negotiated-price supplier crosswalk, supplier invoice documents, partial receipt, truck staging, labeled remnant, and customer invoice. Knoxville's catalog and jobs remain unseeded.

Remaining implementation inputs are third-party account authorization and messaging credentials, physical scanner/printer and mobile-device checks, and the purchased client's catalog, opening counts and agreed accounting rules. Those inputs are collected after the fictional workflow is available for demonstration.
