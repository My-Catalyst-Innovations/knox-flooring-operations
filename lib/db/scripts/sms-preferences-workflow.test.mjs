import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  loadMigrations,
  loadExpectedColumns,
  loadExpectedForeignKeys,
  runMigrations,
} from "./migration-runner.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);
test(
  "SMS preference migration and actual tenant/auth/provider-mock workflow",
  { timeout: 90000 },
  async () => {
    assert.ok(
      process.env.TEST_DATABASE_URL,
      "Use an explicitly supplied disposable loopback PostgreSQL server.",
    );
    const source = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost"].includes(source.hostname));
    const admin = new pg.Client({ connectionString: source.href });
    await admin.connect();
    const names = ["a", "b"].map(
        (suffix) =>
          `sms_preferences_${randomUUID().replaceAll("-", "")}_${suffix}`,
      ),
      clients = [],
      urls = [];
    try {
      const migrations = await loadMigrations();
      assert.equal(migrations.at(-1).id, "0027_sms_consent_preferences");
      assert.equal(migrations.length, 28);
      for (const name of names) {
        assert.match(name, /^sms_preferences_[a-f0-9]{32}_[ab]$/);
        await admin.query(`CREATE DATABASE "${name}"`);
        const url = new URL(source);
        url.pathname = "/" + name;
        urls.push(url.href);
        const c = new pg.Client({ connectionString: url.href });
        await c.connect();
        clients.push(c);
      }
      await runMigrations(clients[0], { migrations: migrations.slice(0, -1) });
      await clients[0].query(
        "INSERT INTO communications(id,channel,direction,status,from_address,to_address,subject,body,provider_message_id,created_at) VALUES ('legacy-stop','sms','inbound','received','+15005550001','+15005550006','SMS opt-out pending provider timestamp','STOP','signalwire:11111111-1111-1111-1111-111111111111:legacy-message','2026-11-23T10:00:00.123456Z'),('legacy-start','sms','inbound','received','+15005550001','+15005550006','SMS opt-in','START','signalwire:11111111-1111-1111-1111-111111111111:later-start','2026-11-23T11:00:00.123456Z')",
      );
      const columns = (
        await clients[0].query(
          "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
        )
      ).rows;
      const tables = {};
      for (const row of columns)
        (tables[row.table_name] ??= []).push(row.column_name);
      const snapshot = async () => {
        const result = {};
        for (const [table, names] of Object.entries(tables)) {
          if (table === "catalyst_schema_migrations") continue;
          assert.match(table, /^[a-z_][a-z0-9_]*$/);
          for (const col of names) assert.match(col, /^[a-z_][a-z0-9_]*$/);
          result[table] = (
            await clients[0].query(
              `SELECT to_jsonb(t)::text row FROM (SELECT ${names.map((c) => '"' + c + '"').join(",")} FROM "${table}") t ORDER BY to_jsonb(t)::text COLLATE "C"`,
            )
          ).rows;
        }
        return result;
      };
      const before = await snapshot(),
        ledger = (
          await clients[0].query(
            "SELECT to_jsonb(t)::text row FROM catalyst_schema_migrations t ORDER BY id",
          )
        ).rows;
      const applied = await runMigrations(clients[0], {
        migrations,
        expectedColumns: await loadExpectedColumns(),
        expectedForeignKeys: await loadExpectedForeignKeys(),
      });
      assert.deepEqual(applied.applied, ["0027_sms_consent_preferences"]);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        (
          await clients[0].query(
            "SELECT to_jsonb(t)::text row FROM catalyst_schema_migrations t ORDER BY id LIMIT 27",
          )
        ).rows,
        ledger,
      );
      const legacy = (
        await clients[0].query(
          "SELECT suppressed,consent_event_id,revision FROM sms_recipient_preferences WHERE recipient='+15005550001'",
        )
      ).rows[0];
      assert.deepEqual(legacy, {
        suppressed: true,
        consent_event_id: null,
        revision: 1,
      });
      await runMigrations(clients[1], { migrations });
      const safeEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(
            key,
          ),
        ),
      );
      const env = {
        ...safeEnv,
        DATABASE_URL: urls[0],
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
        CATALYST_ISOLATED_TEST: "true",
        BACKGROUND_WORKERS_ENABLED: "false",
        CATALYST_WORKSPACES: JSON.stringify([
          { key: "sms-a", origin: "https://a.sms.test" },
          { key: "sms-b", origin: "https://b.sms.test" },
        ]),
      };
      for (let i = 0; i < 2; i++) {
        const prefix = `CATALYST_SMS_${i ? "B" : "A"}_`;
        Object.assign(env, {
          [prefix + "DATABASE_URL"]: urls[i],
          [prefix + "BACKGROUND_WORKERS_ENABLED"]: "false",
          [prefix + "COMMS_DELIVERY_MODE"]: "capture",
          [prefix + "COMMS_SMS_DELIVERY_MODE"]: "live",
          [prefix + "COMMS_SMS_PROVIDER"]: "signalwire",
          [prefix + "SIGNALWIRE_PROJECT_ID"]:
            "11111111-1111-1111-1111-111111111111",
          [prefix + "SIGNALWIRE_API_TOKEN"]: "SYNTHETIC-NO-REAL-PROVIDER-TOKEN",
          [prefix + "SIGNALWIRE_SIGNING_KEY"]: "SYNTHETIC-SIGNING-KEY",
          [prefix + "SIGNALWIRE_SPACE_URL"]: "https://fixture.signalwire.com",
          [prefix + "SIGNALWIRE_FROM_NUMBER"]: "+15005550006",
        });
      }
      const local = path.join(root, ".local");
      await mkdir(local, { recursive: true });
      const folder = await mkdtemp(path.join(local, "sms-preferences-test-"));
      const runner = path.join(folder, "workflow.mjs");
      const { build } = createRequire(
        path.join(root, "artifacts/api-server/package.json"),
      )("esbuild");
      await build({
        entryPoints: [
          path.join(
            root,
            "artifacts/api-server/test-support/sms-preferences-workflow.ts",
          ),
        ],
        outfile: runner,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
        external: ["pg-native"],
        alias: {
          argon2: path.join(
            root,
            "artifacts/api-server/test-support/argon2-node.mjs",
          ),
        },
        banner: {
          js: "import {createRequire as fixtureRequire} from 'node:module';globalThis.require=fixtureRequire(import.meta.url);",
        },
      });
      const result = await execute(process.execPath, [runner], {
        env,
        timeout: 60000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      assert.ok(
        result.stdout.includes(
          "SMS preference actual PostgreSQL workflow passed",
        ),
        result.stdout,
      );
      console.log(result.stdout.trim());
    } finally {
      for (const client of clients) await client.end();
      for (const name of names) {
        assert.match(name, /^sms_preferences_[a-f0-9]{32}_[ab]$/);
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      }
      await admin.end();
    }
  },
);
