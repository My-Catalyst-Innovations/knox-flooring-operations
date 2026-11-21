import type { WorkspaceConfig } from "@workspace/db/workspace";
import { assertMigrationsApplied, pool } from "@workspace/db";

export async function assertWorkspaceReady(workspace?: Pick<WorkspaceConfig, "key">) {
  await assertMigrationsApplied(pool);
  if (!workspace) return;
  const result = await pool.query<{ workspace_key: string }>(
    "SELECT workspace_key FROM public.catalyst_workspace_identity WHERE id = 1",
  );
  if (result.rows[0]?.workspace_key !== workspace.key)
    throw new Error(`Database binding does not match workspace ${workspace.key}.`);
}
