import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { currentWorkspace, workspaceConfigs } from "./workspace";

const { Pool } = pg;

if (!workspaceConfigs.length && !process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function connection(rawUrl: string, max?: number) {
  const url = new URL(rawUrl);
  url.searchParams.set("uselibpqcompat", "true");
  const pool = new Pool({
    connectionString: url.toString(),
    ...(max === undefined ? {} : { max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 }),
  });
  pool.on("error", () => {
    // A disconnected idle client is evicted automatically. Readiness checks
    // report connection failures without including credentials from driver errors.
  });
  return { pool, db: drizzle(pool, { schema }) };
}

const single = !workspaceConfigs.length && process.env.DATABASE_URL
  ? connection(process.env.DATABASE_URL) : undefined;
const hosted = new Map(workspaceConfigs.map((workspace) =>
  [workspace.key, connection(workspace.databaseUrl, workspace.poolMax)],
));

function selectedConnection() {
  const workspace = currentWorkspace();
  const selected = workspace ? hosted.get(workspace.key) : single;
  if (!selected) throw new Error("The workspace database is unavailable.");
  return selected;
}

function scoped<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const selected = resolve();
      const value: unknown = Reflect.get(selected, property, selected);
      return typeof value === "function" ? value.bind(selected) : value;
    },
  });
}

export const pool = scoped(() => selectedConnection().pool);
export const db = scoped(() => selectedConnection().db);

export async function closeWorkspaceConnections() {
  const resources = [...hosted.values(), ...(single ? [single] : [])];
  await Promise.allSettled(resources.map(({ pool }) => pool.end()));
}

export * from "./schema";
export * from "./migration-state";
