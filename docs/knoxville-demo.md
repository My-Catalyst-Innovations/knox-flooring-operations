# Knoxville Flooring demo

Use an empty, isolated Catalyst Works database with the latest migrations. Run `pnpm --filter @workspace/api-server build` and then `pnpm --filter @workspace/api-server seed:demo` with `DEMO_MODE=true` and `ALLOW_DEMO_SEED=true`. Keep Outlook and QuickBooks credentials unset for this walkthrough. The seed refuses to run in a workspace that already contains business records or an integration connection.

## Host the demo on DigitalOcean

1. Publish `codex/knoxville-supplier-preview` to `My-Catalyst-Innovations/knox-flooring-operations` and verify the branch commit and Linux build. [The demo app spec](../.do/knoxville-demo.yaml) uses the public Git clone URL and provisions its own PostgreSQL database in a separate App Platform app.
2. Before creating the demo app, set `OWNER_EMAIL`, `OWNER_NAME`, and an encrypted `OWNER_INITIAL_PASSWORD` of at least 12 characters as runtime variables in the deployment configuration. Leave Outlook, QuickBooks, and email provider credentials unset. The service starts by applying migrations and requires a password for sign-in.
3. Once the deployed commit and `/api/healthz` are verified, open the new app’s web service console. Run `DEMO_MODE=true ALLOW_DEMO_SEED=true pnpm --filter @workspace/api-server seed:demo` once. Keep `ALLOW_DEMO_SEED` out of the runtime configuration.
4. Sign in and verify the three workflows below with the seeded warehouse, supplier, and job records.

## Check stock and receive a transfer

1. In **Inventory**, search for `KNOX-SLATE-48`. The Office warehouse starts with 20 boxes on hand, 8 reserved, and 12 available. The Remote warehouse has 24 boxes on hand and available. Six more boxes are in transit to the Office warehouse.
2. Switch the **Warehouse** filter to review stock from either direction. Choose **Unassigned** to see original demo catalog stock awaiting a physical location count.
3. Open **Stock activity → Warehouse transfers** for `KNOX-SLATE-48` and choose **Receive transfer**. The Office warehouse now has 26 boxes on hand and 18 available. The Remote warehouse remains at 24 boxes.
4. To demonstrate a job leftover, use the existing reservation for `J-KNX-DEMO` to issue the eight boxes to the job. Then use **Return stock**, select the same job and its original issue, and return two boxes to the Office warehouse. The Office warehouse ends at 20 boxes. The movement history shows the warehouse and the original issue.

## Review an invoice line with a vendor price difference

1. In **Inventory → Preview supplier CSV**, use the following data to show the approved supplier alias and a new proposed rate. The approved rate remains $48 until a new effective price is approved.

   ```csv
   supplier,supplier_sku,internal_sku,manufacturer_part_number,unit,unit_cost
   Demo Flooring Supply,00048-SLATE,KNOX-SLATE-48,DEMO-MFR-4820,box,53.00
   ```

2. In **Settings → Supplier bills · simulation**, enter `Demo Flooring Supply`, bill number `DEMO-SLATE-01`, today’s date, and source total `106.00`. Add supplier SKU `00048-SLATE`, unit `box`, quantity `2`, and billed unit cost `53.00`.
3. Choose **Preview supplier bill**. Verify that the vendor code matches `KNOX-SLATE-48` and the preview flags the difference between the negotiated $48 and billed $53 per box. Use **Queue for approval**, then approve the simulated bill. The simulation stays in the demo workspace.

## Book the installation and log a job update

1. Open **Today → Job workflow** and find `J-KNX-DEMO`, **Sample Knoxville Kitchen**. It has an accepted quote, an eight-box material requirement, and draft invoice `INV-KNX-DEMO`.
2. Choose **Schedule**, or open **Installations** and drag the job to the planned working day. Choose **Demo Installation Crew**, book a two-hour slot such as 8–10 a.m., enter four planned person-hours, and save. The booking requires crew availability and capacity checks.
3. Open the job’s **Work order** and **Quick update** controls to walk through an installer handoff. Outlook confirmation requires a separately configured Microsoft test calendar. [Outlook setup](../README.md#outlook-calendar-setup)
