import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import {
  loadMigrations,
  loadExpectedColumns,
  loadExpectedForeignKeys,
  runMigrations,
} from "./migration-runner.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url)),
  execute = promisify(execFile);
test(
  "owner legacy history retains original sources and private files without changing active company records",
  { timeout: 120000, skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const source = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost"].includes(source.hostname));
    const tag = randomUUID().replaceAll("-", ""),
      names = ["a", "b"].map((letter) => `legacy_archive_${tag}_${letter}`),
      urls = names.map((name) => {
        const url = new URL(source);
        url.pathname = "/" + name;
        return url.href;
      });
    const admin = new pg.Client({ connectionString: source.href });
    await admin.connect();
    const folder = await mkdtemp(path.join(tmpdir(), "legacy-archive-test-"));
    try {
      for (let index = 0; index < 2; index++) {
        assert.match(names[index], /^legacy_archive_[a-f0-9]{32}_[ab]$/);
        await admin.query(`CREATE DATABASE "${names[index]}"`);
        const client = new pg.Client({ connectionString: urls[index] });
        await client.connect();
        try {
          await runMigrations(client, {
            migrations: await loadMigrations(),
            expectedColumns: await loadExpectedColumns(),
            expectedForeignKeys: await loadExpectedForeignKeys(),
          });
        } finally {
          await client.end();
        }
      }
      const require = createRequire(
          path.join(root, "artifacts/api-server/package.json"),
        ),
        { build } = require("esbuild"),
        runner = path.join(folder, "legacy-history-workflow.mjs");
      await build({
        entryPoints: [
          path.join(
            root,
            "artifacts/api-server/test-support/legacy-history-workflow.ts",
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
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(
            key,
          ),
        ),
      );
      Object.assign(env, {
        NODE_ENV: "production",
        DATABASE_URL: urls[0],
        CATALYST_ISOLATED_TEST: "true",
        PLATFORM_ENABLED: "false",
        DEMO_MODE: "false",
        DEMO_ACCESS_ENABLED: "false",
        BACKGROUND_WORKERS_ENABLED: "false",
        LOG_LEVEL: "silent",
        CATALYST_WORKSPACES: JSON.stringify([
          { key: "archive-a", origin: "https://a.archive.test" },
          { key: "archive-b", origin: "https://b.archive.test" },
        ]),
        CATALYST_ARCHIVE_A_DATABASE_URL: urls[0],
        CATALYST_ARCHIVE_B_DATABASE_URL: urls[1],
        CATALYST_ARCHIVE_A_AZURE_STORAGE_ACCOUNT_URL:
          "https://fixtureaccount.blob.core.windows.net",
        CATALYST_ARCHIVE_B_AZURE_STORAGE_ACCOUNT_URL:
          "https://fixtureaccount.blob.core.windows.net",
        CATALYST_ARCHIVE_A_AZURE_STORAGE_CONTAINER: "archive-a-private",
        CATALYST_ARCHIVE_B_AZURE_STORAGE_CONTAINER: "archive-b-private",
        IDENTITY_ENDPOINT: "http://127.0.0.1:8181/token",
        IDENTITY_HEADER: "synthetic-archive-identity",
      });
      const result = await execute(process.execPath, [runner], {
        env,
        cwd: root,
        timeout: 100000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const line = result.stdout
        .trim()
        .split(/\r?\n/)
        .findLast((value) => value.startsWith('{"legacyHistory"'));
      assert.ok(line, result.stderr.slice(-1500));
      const evidence = JSON.parse(line);
      assert.equal(evidence.legacyHistory, "passed");
      assert.equal(evidence.unexpectedProviderCalls, 0);
      assert.equal(evidence.activeRecordsChanged, false);
      assert.ok(evidence.checks.length >= 18);
      console.log(
        `Legacy archive PostgreSQL checks: ${evidence.checks.length}; tenant databases:2; live providers:0; active records changed:false.`,
      );
    } finally {
      for (const name of names)
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
      assert.ok(
        path
          .resolve(folder)
          .startsWith(
            path.join(path.resolve(tmpdir()), "legacy-archive-test-"),
          ),
      );
      await rm(folder, { recursive: true, force: true });
    }
  },
);
