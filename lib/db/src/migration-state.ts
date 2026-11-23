/** Keep in sync with the immutable SQL migrations; the database test verifies this list. */
export const schemaMigrationIds = [
  "0000_baseline", "0001_catalyst_operations", "0002_booking_links", "0003_link_existing_customers",
  "0004_booking_sync_status", "0005_callback_cost_links", "0006_job_history_guards", "0007_job_updates",
  "0008_warehouse_inventory", "0009_supplier_catalog", "0010_outlook_calendar", "0011_inventory_issue_cost",
  "0012_purchase_orders_and_bins", "0013_inventory_quantity_precision",
  "0014_inventory_purchase_costing", "0015_purchase_receipt_damage",
  "0016_job_purchasing_and_physical_pieces",
  "0017_staging_counts_and_operational_kpis",
  "0018_workspace_identity_and_purchase_units",
  "0019_outlook_mailbox_sender",
  "0020_physical_piece_cost_provenance",
  "0021_user_profiles",
  "0022_outlook_external_change_review",
  "0023_microsoft_selected_files",
] as const;

export async function assertMigrationsApplied(client: { query: (text: string) => Promise<{ rows: Array<{ id: string }> }> }) {
  const { rows } = await client.query("SELECT id FROM public.catalyst_schema_migrations ORDER BY id");
  if (rows.length !== schemaMigrationIds.length || rows.some((row, index) => row.id !== schemaMigrationIds[index])) {
    throw new Error("The database migration version does not match this application release.");
  }
}
