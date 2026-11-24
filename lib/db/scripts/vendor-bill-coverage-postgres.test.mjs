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
const root = fileURLToPath(new URL("../../../", import.meta.url));
test(
  "receipt/bill coverage HTTP approval, immutable originals and accounting cases use actual isolated PostgreSQL",
  { timeout: 120000, skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const source = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost"].includes(source.hostname));
    const tag = randomUUID().replaceAll("-", ""),
      names = ["a", "b"].map((letter) => `bill_coverage_${tag}_${letter}`);
    const urls = names.map((name) => {
      const value = new URL(source);
      value.pathname = "/" + name;
      return value.href;
    });
    const admin = new pg.Client({ connectionString: source.href });
    await admin.connect();
    const folder = await mkdtemp(
      path.join(tmpdir(), "bill-coverage-workflow-"),
    );
    try {
      for (let index = 0; index < 2; index++) {
        assert.match(names[index], /^bill_coverage_[a-f0-9]{32}_[ab]$/);
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
      );
      const runner = path.join(folder, "workflow.mjs");
      await require("esbuild").build({
        entryPoints: [
          path.join(
            root,
            "artifacts/api-server/test-support/vendor-bill-coverage-workflow.ts",
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
        IDENTITY_ENDPOINT: "http://127.0.0.1:8181/token",
        IDENTITY_HEADER: "synthetic-coverage-identity",
        CATALYST_WORKSPACES: JSON.stringify([
          { key: "coverage-a", origin: "https://a.coverage.test" },
          { key: "coverage-b", origin: "https://b.coverage.test" },
        ]),
      });
      for (let index = 0; index < 2; index++)
        Object.assign(env, {
          [`CATALYST_COVERAGE_${index ? "B" : "A"}_DATABASE_URL`]: urls[index],
          [`CATALYST_COVERAGE_${index ? "B" : "A"}_AZURE_STORAGE_ACCOUNT_URL`]:
            "https://fixtureaccount.blob.core.windows.net",
          [`CATALYST_COVERAGE_${index ? "B" : "A"}_AZURE_STORAGE_CONTAINER`]: `coverage-${index ? "b" : "a"}-private`,
          [`CATALYST_COVERAGE_${index ? "B" : "A"}_QUICKBOOKS_ENCRYPTION_KEY`]:
            "synthetic-coverage-encryption-only",
          [`CATALYST_COVERAGE_${index ? "B" : "A"}_QUICKBOOKS_CLIENT_ID`]:
            "synthetic-client",
          [`CATALYST_COVERAGE_${index ? "B" : "A"}_QUICKBOOKS_CLIENT_SECRET`]:
            "synthetic-client-secret",
        });
      const result = await promisify(execFile)(process.execPath, [runner], {
        env,
        cwd: root,
        timeout: 100000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const line = result.stdout
        .trim()
        .split(/\r?\n/)
        .findLast((value) => value.startsWith('{"billCoverage"'));
      assert.ok(line, result.stderr.slice(-2000));
      const evidence = JSON.parse(line);
      assert.equal(evidence.billCoverage, "passed");
      assert.equal(evidence.unexpectedCalls, 0);
      assert.equal(evidence.financialProviderPosts, 0);
      assert.ok(evidence.checks.length >= 15);
      console.log(JSON.stringify(evidence));
    } finally {
      for (const name of names)
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
      assert.ok(
        path
          .resolve(folder)
          .startsWith(
            path.join(path.resolve(tmpdir()), "bill-coverage-workflow-"),
          ),
      );
      await rm(folder, { recursive: true, force: true });
    }
  },
);
