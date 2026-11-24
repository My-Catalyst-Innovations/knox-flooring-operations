import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import pg from "pg";
import {
  loadMigrations,
  loadExpectedColumns,
  loadExpectedForeignKeys,
  runMigrations,
} from "./migration-runner.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
test(
  "outstanding PO import uses real tenant databases, actual owner routes, preserved receipts and atomic replay",
  { timeout: 120000, skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const administrative = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(administrative.hostname),
      "Open PO fixtures refuse non-loopback databases.",
    );
    const tag = randomUUID().replaceAll("-", "");
    const names = ["a", "b"].map((letter) => `open_po_import_${tag}_${letter}`);
    const urls = names.map((name) => {
      const url = new URL(administrative);
      url.pathname = `/${name}`;
      return url.toString();
    });
    const admin = new pg.Client({
      connectionString: administrative.toString(),
    });
    await admin.connect();
    const folder = await mkdtemp(path.join(tmpdir(), "open-po-import-test-"));
    const require = createRequire(
      path.join(root, "artifacts/api-server/package.json"),
    );
    const { build } = require("esbuild");
    const created = [];
    try {
      for (let index = 0; index < names.length; index++) {
        assert.match(names[index], /^open_po_import_[a-f0-9]{32}_[ab]$/);
        await admin.query(`CREATE DATABASE "${names[index]}"`);
        created.push(names[index]);
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
      const runner = path.join(folder, "open-po-import-fixture.mjs");
      await build({
        entryPoints: [
          path.join(
            root,
            "artifacts/api-server/test-support/open-po-import-workflow.ts",
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
        Object.entries(process.env).filter(([name]) =>
          /^(path|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata)$/i.test(
            name,
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
          { key: "import-a", origin: "https://a.import.test" },
          { key: "import-b", origin: "https://b.import.test" },
        ]),
        CATALYST_IMPORT_A_DATABASE_URL: urls[0],
        CATALYST_IMPORT_B_DATABASE_URL: urls[1],
      });
      let output = "";
      const child = spawn(process.execPath, [runner], {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const timer = setTimeout(() => child.kill(), 100000);
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      clearTimeout(timer);
      assert.equal(code, 0, output);
      const line = output
        .trim()
        .split(/\r?\n/)
        .findLast((value) => value.startsWith('{"openPoMigration"'));
      assert.ok(line, output);
      const result = JSON.parse(line);
      assert.equal(result.openPoMigration, "passed");
      assert.equal(result.providerCalls, 0);
      assert.ok(result.checks.length >= 20);
      console.log(
        `Open PO migration PostgreSQL checks: ${result.checks.length}; tenant databases: 2; provider calls: 0.`,
      );
    } finally {
      for (const name of created) {
        assert.match(name, /^open_po_import_[a-f0-9]{32}_[ab]$/);
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
      await admin.end();
      assert.ok(
        path
          .resolve(folder)
          .startsWith(
            path.join(path.resolve(tmpdir()), "open-po-import-test-"),
          ),
      );
      await rm(folder, { recursive: true, force: true });
    }
  },
);
