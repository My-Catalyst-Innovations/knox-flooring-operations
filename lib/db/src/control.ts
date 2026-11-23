// Infrastructure clients are explicit. They never resolve a company database from request context.
import pg from "pg";
export const ControlPool = pg.Pool;
export const ProvisioningClient = pg.Client;
