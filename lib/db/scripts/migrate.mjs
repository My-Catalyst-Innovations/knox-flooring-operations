import pg from "pg";
import { loadExpectedColumns, loadExpectedForeignKeys, loadMigrations, runMigrations } from "./migration-runner.mjs";
import { readWorkspaceConfigs } from "../src/workspace-config.ts";

try {
  const workspaces = readWorkspaceConfigs();
  if (!workspaces.length && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database migrations.");
  const jobs = workspaces.length ? workspaces : [{ key: null, databaseUrl: process.env.DATABASE_URL }];
  const options = {
    migrations: await loadMigrations(), expectedColumns: await loadExpectedColumns(), expectedForeignKeys: await loadExpectedForeignKeys(),
    checkOnly: process.argv.includes("--check"),
  };
  for (const { key, databaseUrl } of jobs) {
    const url = new URL(databaseUrl);
    url.searchParams.set("uselibpqcompat", "true");
    const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15_000 });
    try {
      await client.connect();
      if (key) {
        const binding = await client.query("SELECT workspace_key FROM public.catalyst_workspace_identity WHERE id = 1");
        if (binding.rows[0]?.workspace_key !== key) throw new Error(`Database binding does not match workspace ${key}.`);
      }
      const description = key ? `Workspace ${key}` : "Database";
      const result = await runMigrations(client, {
        ...options, onApplied: (id) => console.log(`${description} applied migration ${id}`),
      });
      console.log(`${description} ready at ${result.version}. Existing business records preserved.`);
    } finally {
      await client.end();
    }
  }
} catch (error) {
  // Do not print connection URLs, connection options, or credential-bearing errors.
  console.error(`Migration failed: ${error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database URL]") : "Unknown error"}`);
  process.exitCode = 1;
}
