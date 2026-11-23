import { AsyncLocalStorage } from "node:async_hooks";
import { readWorkspaceConfigs, type WorkspaceConfig } from "./workspace-config";
export type { WorkspaceConfig } from "./workspace-config";

export const workspaceConfigs = readWorkspaceConfigs();
const hostLookup = new Map(workspaceConfigs.map((workspace) => [workspace.host, workspace]));
const dynamicHosts = new Set<string>();
let resolver: ((host: string, path: string) => Promise<WorkspaceConfig | null>) | undefined;
const context = new AsyncLocalStorage<WorkspaceConfig>();

export function workspaceForHost(host: string | undefined) {
  return host ? hostLookup.get(host.toLowerCase()) : undefined;
}

export function installWorkspaceResolver(resolve: typeof resolver) { resolver = resolve; }
export function isDynamicWorkspace(host: string) { return dynamicHosts.has(host); }
export function registerTrustedWorkspace(workspace: WorkspaceConfig) {
  const databaseIdentity = (value: string) => { const url = new URL(value); return `${url.hostname.toLowerCase()}:${url.port || 5432}${url.pathname}`; };
  const existing = hostLookup.get(workspace.host);
  if (existing && !dynamicHosts.has(workspace.host)) {
    if (existing.key !== workspace.key || existing.databaseUrl !== workspace.databaseUrl)
      throw new Error("A provisioned company cannot replace a configured workspace.");
    return existing;
  }
  if (existing && databaseIdentity(existing.databaseUrl) !== databaseIdentity(workspace.databaseUrl))
    throw new Error("A company database identity cannot change during a request.");
  if ([...hostLookup.values()].some((candidate) => candidate.host !== workspace.host &&
    (candidate.key === workspace.key || databaseIdentity(candidate.databaseUrl) === databaseIdentity(workspace.databaseUrl))))
    throw new Error("Provisioned company resources must be unique.");
  const environmentIdentity = (value: Readonly<NodeJS.ProcessEnv>) => JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  if (existing && existing.key === workspace.key && existing.databaseUrl === workspace.databaseUrl &&
    environmentIdentity(existing.environment) === environmentIdentity(workspace.environment)) return existing;
  dynamicHosts.add(workspace.host); hostLookup.set(workspace.host, workspace); return workspace;
}
export async function resolveWorkspaceForHost(host: string | undefined, path: string) {
  if (!host) return undefined;
  const canonical = host.toLowerCase();
  if (resolver && (dynamicHosts.has(canonical) || !hostLookup.has(canonical))) {
    const workspace = await resolver(canonical, path);
    return workspace ? registerTrustedWorkspace(workspace) : undefined;
  }
  return hostLookup.get(canonical);
}

export function inWorkspace<T>(workspace: WorkspaceConfig, task: () => T) {
  if (hostLookup.get(workspace.host) !== workspace) throw new Error("Workspace is outside this deployment.");
  return context.run(workspace, task);
}

export function currentWorkspace() {
  const workspace = context.getStore();
  if (!workspace && workspaceConfigs.length) throw new Error("A workspace context is required.");
  return workspace;
}

export function workspaceEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return currentWorkspace()?.environment ?? process.env;
}

export function workspaceScopeKey() {
  return currentWorkspace()?.key ?? "";
}
