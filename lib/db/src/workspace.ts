import { AsyncLocalStorage } from "node:async_hooks";
import { readWorkspaceConfigs, type WorkspaceConfig } from "./workspace-config";
export type { WorkspaceConfig } from "./workspace-config";

export const workspaceConfigs = readWorkspaceConfigs();
const hostLookup = new Map(workspaceConfigs.map((workspace) => [workspace.host, workspace]));
const context = new AsyncLocalStorage<WorkspaceConfig>();

export function workspaceForHost(host: string | undefined) {
  return host ? hostLookup.get(host.toLowerCase()) : undefined;
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
