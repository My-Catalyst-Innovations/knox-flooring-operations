export interface WorkspaceConfig {
  key: string;
  origin: string;
  host: string;
  databaseUrl: string;
  poolMax: number;
  environment: Readonly<NodeJS.ProcessEnv>;
}

const keyPattern = /^[a-z][a-z0-9-]{1,47}$/;

export function readWorkspaceConfigs(env: NodeJS.ProcessEnv = process.env): WorkspaceConfig[] {
  if (env.CATALYST_WORKSPACES === undefined) return [];
  let input: unknown;
  try { input = JSON.parse(env.CATALYST_WORKSPACES); }
  catch { throw new Error("CATALYST_WORKSPACES must be a JSON array of workspace keys and HTTPS origins."); }
  if (!Array.isArray(input) || !input.length)
    throw new Error("CATALYST_WORKSPACES must name at least one workspace.");

  const connections = Number(env.CATALYST_WORKSPACE_CONNECTIONS ?? 24);
  if (!Number.isSafeInteger(connections) || connections < input.length || connections > 120)
    throw new Error("Set a workspace connection budget between the workspace count and 120.");
  const keys = new Set<string>();
  const hosts = new Set<string>();
  const databases = new Set<string>();
  const containers = new Set<string>();
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid workspace entry.");
    const { key, origin } = entry as { key?: unknown; origin?: unknown };
    if (typeof key !== "string" || !keyPattern.test(key) || keys.has(key) || typeof origin !== "string")
      throw new Error("Workspace keys must be unique lowercase slugs, each with an HTTPS origin.");
    let address: URL;
    try { address = new URL(origin); }
    catch { throw new Error(`Invalid HTTPS origin for workspace ${key}.`); }
    if (address.protocol !== "https:" || origin !== address.origin || address.port ||
      !address.hostname.includes(".") || address.hostname.endsWith(".") || hosts.has(address.hostname))
      throw new Error(`Use a unique canonical HTTPS origin for workspace ${key}.`);
    keys.add(key);
    hosts.add(address.hostname);

    const prefix = `CATALYST_${key.toUpperCase().replaceAll("-", "_")}_`;
    const variables: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(env)) {
      if (name.startsWith(prefix) && value !== undefined) variables[name.slice(prefix.length)] = value;
    }

    let database: URL;
    try { database = new URL(variables.DATABASE_URL ?? ""); }
    catch { throw new Error(`Configure a private PostgreSQL database for workspace ${key}.`); }
    if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname ||
      !/^\/[A-Za-z0-9_-]+$/.test(database.pathname))
      throw new Error(`Configure a named PostgreSQL database for workspace ${key}.`);
    if (["host", "hostaddr", "port", "database", "dbname", "service"].some((name) => database.searchParams.has(name)))
      throw new Error(`Set the PostgreSQL server and database for workspace ${key} in the URL authority and path.`);
    const databaseAddress = JSON.stringify([
      database.hostname.toLowerCase().replace(/\.$/, ""), Number(database.port || "5432"), database.pathname,
    ]);
    if (databases.has(databaseAddress)) throw new Error("Each workspace must use its own PostgreSQL database.");
    databases.add(databaseAddress);
    database.searchParams.set("uselibpqcompat", "true");

    const account = variables.AZURE_STORAGE_ACCOUNT_URL;
    const container = variables.AZURE_STORAGE_CONTAINER;
    if (account || container) {
      const accountName = /^https:\/\/([a-z0-9]{3,24})\.blob\.core\.windows\.net\/?$/.exec(account ?? "")?.[1];
      if (!accountName || !container || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container))
        throw new Error(`Configure a valid Azure storage account and private container for workspace ${key}.`);
      const location = `${accountName}/${container}`;
      if (containers.has(location)) throw new Error("Each workspace must use a separate Azure Blob container.");
      containers.add(location);
    }

    // Scoped integration configuration is fail-closed. Process-level deployment secrets
    // and local/Replit storage can never be inherited by a hosted workspace.
    delete variables.DATABASE_URL;
    delete variables.PRIVATE_OBJECT_DIR;
    delete variables.PUBLIC_OBJECT_SEARCH_PATHS;
    delete variables.REPLIT_CONNECTORS_HOSTNAME;
    delete variables.REPL_IDENTITY;
    delete variables.WEB_REPL_RENEWAL;
    return {
      key,
      origin,
      host: address.hostname,
      databaseUrl: database.toString(),
      poolMax: Math.floor(connections / input.length),
      environment: Object.freeze({
        ...variables,
        APP_BASE_URL: origin,
        QUICKBOOKS_REDIRECT_URI: `${origin}/api/quickbooks/callback`,
        OUTLOOK_REDIRECT_URI: `${origin}/api/calendar/outlook/callback`,
        IDENTITY_ENDPOINT: env.IDENTITY_ENDPOINT,
        IDENTITY_HEADER: env.IDENTITY_HEADER,
        DEMO_MODE: "false",
        DEMO_ACCESS_ENABLED: "false",
      }),
    };
  });
}
