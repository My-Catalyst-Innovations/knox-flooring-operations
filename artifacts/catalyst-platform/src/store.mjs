import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PlatformError, hash, token } from "./config.mjs";

export async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export function databaseIdentity(value) {
  const u = new URL(value);
  return `${u.hostname.toLowerCase()}:${u.port || 5432}${u.pathname}`;
}
export async function openPlatformPool(Pool, config, vault) {
  const url = await vault.secret(config.refs.database);
  const parsed = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^\/[A-Za-z0-9_-]+$/.test(parsed.pathname)
  )
    throw new PlatformError(
      503,
      "database",
      "Configure the separate control-plane database.",
    );
  if (
    config.legacyDatabase &&
    databaseIdentity(url) === databaseIdentity(config.legacyDatabase)
  )
    throw new PlatformError(
      503,
      "database_boundary",
      "The control plane cannot use the existing company database.",
    );
  const pool = new Pool({
    connectionString: url,
    max: config.processRole === "provisioner" ? 1 : 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8000,
  });
  pool.on("error", () => {});
  try {
    const result = await pool.query(
      "SELECT to_regclass('public.catalyst_schema_migrations') AS tenant, to_regclass('public.users') AS users",
    );
    if (result.rows[0]?.tenant || result.rows[0]?.users)
      throw new PlatformError(
        503,
        "database_boundary",
        "The configured database contains company records. Choose a separate control-plane database.",
      );
    const foreign = await pool.query(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'platform_%' LIMIT 1",
    );
    if (foreign.rows.length)
      throw new PlatformError(
        503,
        "database_boundary",
        "The control-plane database must be separate from other applications.",
      );
  } catch (error) {
    await pool.end();
    throw error;
  }
  return pool;
}
export async function migratePlatform(
  pool,
  directory,
  { checkOnly = false } = {},
) {
  const files = (await readdir(directory))
    .filter((v) => /^\d{4}_[a-z0-9_]+\.sql$/.test(v))
    .sort();
  if (!files.length)
    throw new PlatformError(
      503,
      "migrations",
      "No platform migrations were found.",
    );
  const client = await pool.connect();
  try {
    const locked = await client.query(
      "SELECT pg_try_advisory_lock(1959031429) AS acquired",
    );
    if (!locked.rows[0]?.acquired)
      throw new PlatformError(
        503,
        "migration_lock",
        "Another platform migration is running.",
      );
    const exists = await client.query(
      "SELECT to_regclass('public.platform_schema_migrations') AS ledger",
    );
    if (!exists.rows[0]?.ledger) {
      if (checkOnly)
        throw new PlatformError(
          503,
          "migrations",
          "Control-plane migrations have not been applied.",
        );
      await client.query(
        "CREATE TABLE platform_schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
    }
    const applied = (
      await client.query(
        "SELECT id,checksum FROM platform_schema_migrations ORDER BY id",
      )
    ).rows;
    if (applied.some((row) => !files.includes(row.id)))
      throw new PlatformError(
        503,
        "migrations",
        "The platform database has an unknown migration.",
      );
    let pendingSeen = false;
    for (const file of files) {
      const sql = (await readFile(path.join(directory, file), "utf8")).replace(
          /\r\n/g,
          "\n",
        ),
        checksum = createHash("sha256").update(sql).digest("hex"),
        saved = applied.find((v) => v.id === file);
      if (saved) {
        if (pendingSeen || saved.checksum !== checksum)
          throw new PlatformError(
            503,
            "migrations",
            "Platform migration history changed or contains a gap.",
          );
        continue;
      }
      pendingSeen = true;
      if (checkOnly)
        throw new PlatformError(
          503,
          "migrations",
          "Control-plane migrations await deployment.",
        );
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout='15s'");
        await client.query(sql);
        await client.query(
          "INSERT INTO platform_schema_migrations(id,checksum) VALUES($1,$2)",
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return files.at(-1);
  } finally {
    await client.query("SELECT pg_advisory_unlock(1959031429)").catch(() => {});
    client.release();
  }
}
export function createStore(pool) {
  const query = (sql, values = []) => pool.query(sql, values);
  async function rate(scope, value, limit) {
    const bucket = Math.floor(Date.now() / 3_600_000),
      key = `${scope}:${hash(String(value))}:${bucket}`;
    const result = await query(
      "INSERT INTO platform_rate_limits(key,expires_at) VALUES($1,now()+interval '2 hours') ON CONFLICT(key) DO UPDATE SET used=platform_rate_limits.used+1 RETURNING used",
      [key],
    );
    if (result.rows[0].used > limit)
      throw new PlatformError(
        429,
        "rate_limit",
        "Please wait before requesting another account email.",
      );
  }
  async function audit(
    action,
    { organizationId = null, accountId = null, details = {} } = {},
    writer = pool,
  ) {
    await writer.query(
      "INSERT INTO platform_audit(id,organization_id,account_id,action,details) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), organizationId, accountId, action, details],
    );
  }
  async function session(raw) {
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const result = await query(
      "SELECT s.id AS session_id,s.csrf_token,a.id,a.name,a.email FROM platform_sessions s JOIN platform_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.verified_at IS NOT NULL",
      [hash(raw)],
    );
    return result.rows[0] ?? null;
  }
  async function organization(id, accountId, writer = pool) {
    if (!/^[0-9a-f-]{36}$/i.test(id ?? ""))
      throw new PlatformError(400, "organization", "Choose a company.");
    const result = await writer.query(
      "SELECT o.* FROM platform_organizations o JOIN platform_memberships m ON m.organization_id=o.id WHERE o.id=$1 AND m.account_id=$2 AND m.role IN ('owner','billing_admin')",
      [id, accountId],
    );
    if (!result.rows[0])
      throw new PlatformError(404, "organization", "Company not found.");
    return result.rows[0];
  }
  async function newOrganization(writer, accountId, input) {
    const id = randomUUID();
    const row = await writer.query(
      "INSERT INTO platform_organizations(id,owner_account_id,slug,company_name,profile) VALUES($1,$2,$3,$4,$5) ON CONFLICT(slug) DO NOTHING RETURNING *",
      [
        id,
        accountId,
        input.slug,
        input.company,
        { acceptedTermsAt: new Date().toISOString(), termsUrl: input.termsUrl },
      ],
    );
    if (!row.rows[0])
      throw new PlatformError(
        409,
        "slug",
        "That company address is already reserved. Choose another address.",
      );
    await writer.query(
      "INSERT INTO platform_memberships(organization_id,account_id,role) VALUES($1,$2,'owner')",
      [id, accountId],
    );
    await audit(
      "company.signup_verified",
      { organizationId: id, accountId },
      writer,
    );
    return row.rows[0];
  }
  async function consumeToken(raw) {
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw))
      throw new PlatformError(
        400,
        "token",
        "This account link is invalid or expired. Request another link.",
      );
    return transaction(pool, async (writer) => {
      const tokenRow = (
        await writer.query(
          "SELECT * FROM platform_tokens WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL FOR UPDATE",
          [hash(raw)],
        )
      ).rows[0];
      if (!tokenRow)
        throw new PlatformError(
          400,
          "token",
          "This account link is invalid or expired. Request another link.",
        );
      await writer.query(
        "UPDATE platform_tokens SET used_at=now() WHERE id=$1",
        [tokenRow.id],
      );
      if (tokenRow.purpose === "email_change") {
        await writer.query(
          "UPDATE platform_accounts SET email=$1,verified_at=now(),updated_at=now() WHERE id=$2",
          [tokenRow.context.email, tokenRow.account_id],
        );
        await writer.query(
          "DELETE FROM platform_sessions WHERE account_id=$1",
          [tokenRow.account_id],
        );
        await writer.query(
          "UPDATE platform_tokens SET used_at=now() WHERE account_id=$1 AND used_at IS NULL",
          [tokenRow.account_id],
        );
      } else
        await writer.query(
          "UPDATE platform_accounts SET verified_at=COALESCE(verified_at,now()),updated_at=now() WHERE id=$1",
          [tokenRow.account_id],
        );
      let company;
      if (tokenRow.context?.company)
        company = await newOrganization(
          writer,
          tokenRow.account_id,
          tokenRow.context,
        );
      const rawSession = token(),
        csrf = token();
      await writer.query(
        "INSERT INTO platform_sessions(id,account_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')",
        [randomUUID(), tokenRow.account_id, hash(rawSession), csrf],
      );
      await audit(
        "account.email_verified",
        { accountId: tokenRow.account_id },
        writer,
      );
      return { rawSession, csrf, organizationId: company?.id };
    });
  }
  async function claim(table) {
    if (
      ![
        "platform_billing_events",
        "platform_email_outbox",
        "platform_provisioning_jobs",
      ].includes(table)
    )
      throw Error("Invalid queue");
    const primary =
        table === "platform_provisioning_jobs" ? "organization_id" : "id",
      lease = randomUUID();
    const state =
      table === "platform_provisioning_jobs"
        ? ""
        : "AND state IN ('pending','processing')";
    return transaction(pool, async (writer) => {
      const row = (
        await writer.query(
          `SELECT ${primary} FROM ${table} WHERE next_attempt_at<=now() AND (locked_until IS NULL OR locked_until<now()) ${state} ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return null;
      const result = await writer.query(
        `UPDATE ${table} SET locked_until=now()+interval '5 minutes',lease_token=$2,attempts=attempts+1 ${table === "platform_provisioning_jobs" ? "" : ",state='processing'"} WHERE ${primary}=$1 RETURNING *`,
        [row[primary], lease],
      );
      return result.rows[0];
    });
  }
  return {
    pool,
    query,
    rate,
    audit,
    session,
    organization,
    newOrganization,
    consumeToken,
    claim,
    transaction: (action) => transaction(pool, action),
  };
}
