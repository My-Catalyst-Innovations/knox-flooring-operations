import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { currentWorkspace, workspaceConfigs, workspaceForHost } from "./workspace";

const { Pool } = pg;

if (!workspaceConfigs.length && !process.env.DATABASE_URL && !process.env.PLATFORM_PROCESS_ROLE) {
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

const provisioningProcess = process.env.PLATFORM_PROCESS_ROLE === "provisioner";
const platformEnabled = process.env.PLATFORM_ENABLED === "true";
const single = !process.env.PLATFORM_PROCESS_ROLE && !workspaceConfigs.length && process.env.DATABASE_URL
  ? connection(process.env.DATABASE_URL, 10) : undefined;
type HostedConnection = ReturnType<typeof connection> & { leases: number; usedAt: number; max: number; url: string };
const hosted = new Map<string, HostedConnection>();
const rawBudget = Number(process.env.PLATFORM_DB_CONNECTION_BUDGET ?? 33);
const connectionBudget = Number.isSafeInteger(rawBudget) && rawBudget >= 17 && rawBudget <= 40 ? rawBudget : 33;
// Budget includes the existing default pool, four HTTP control-plane connections,
// and three connections in the separately operated provisioning process (control,
// serialized admin guard, and one migration/owner connection).
const hostedBudget = provisioningProcess ? 1 : platformEnabled ? Math.max(0, connectionBudget - (single ? 10 : 0) - 4 - 3) : 120;
const hostedPoolLimit = provisioningProcess ? 1 : platformEnabled ? 8 : 120;
const hostedMax = (workspace: { poolMax: number }) => provisioningProcess ? 1 : platformEnabled ? Math.min(2, workspace.poolMax) : workspace.poolMax;
function createHosted(workspace: NonNullable<ReturnType<typeof currentWorkspace>>) {
  const max = hostedMax(workspace);
  if (hosted.size >= hostedPoolLimit || [...hosted.values()].reduce((total, value) => total + value.max, 0) + max > hostedBudget)
    throw new Error("Company database capacity is busy. Retry shortly.");
  const value = { ...connection(workspace.databaseUrl, max), leases: 0, usedAt: Date.now(), max, url: workspace.databaseUrl };
  hosted.set(workspace.key, value); return value;
}
let allocation = Promise.resolve();
export async function leaseWorkspaceConnection(workspace: NonNullable<ReturnType<typeof currentWorkspace>>) {
  if (workspaceForHost(workspace.host) !== workspace) throw new Error("Company configuration changed. Retry with the current workspace.");
  const previous = allocation;
  let unlock!: () => void;
  allocation = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  let selected: HostedConnection;
  try {
    selected = hosted.get(workspace.key)!;
    if (selected && selected.url !== workspace.databaseUrl) {
      if (selected.leases || selected.pool.totalCount !== selected.pool.idleCount || selected.pool.waitingCount)
        throw new Error("Company database credentials are being refreshed. Retry shortly.");
      await selected.pool.end(); hosted.delete(workspace.key); selected = undefined!;
    }
    if (!selected) {
      const max = hostedMax(workspace);
      while (hosted.size >= hostedPoolLimit || [...hosted.values()].reduce((total, value) => total + value.max, 0) + max > hostedBudget) {
        const idle = [...hosted.entries()].filter(([, value]) => value.leases === 0 && value.pool.totalCount === value.pool.idleCount && value.pool.waitingCount === 0)
          .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
        if (!idle) throw new Error("Company database capacity is busy. Retry shortly.");
        await idle[1].pool.end(); hosted.delete(idle[0]);
      }
      selected = createHosted(workspace);
    }
    selected.leases++; selected.usedAt = Date.now();
  } finally { unlock(); }
  let released = false;
  return async () => {
    if (released) return; released = true;
    selected.leases--; selected.usedAt = Date.now();
    if (provisioningProcess && selected.leases === 0) { await selected.pool.end(); hosted.delete(workspace.key); }
  };
}
export async function withWorkspaceConnection<T>(action: () => Promise<T>) {
  const workspace = currentWorkspace();
  if (!workspace) return action();
  const release = await leaseWorkspaceConnection(workspace);
  try { return await action(); } finally { await release(); }
}

function selectedConnection() {
  const workspace = currentWorkspace();
  const selected = workspace ? (hosted.get(workspace.key) ?? createHosted(workspace)) : single;
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
