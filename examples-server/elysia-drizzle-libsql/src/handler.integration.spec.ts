import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { drizzleAdapter } from "@hot-updater/server/adapters/drizzle";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights as insightsPlugin,
} from "@hot-updater/server/plugins/insights";
import {
  createHttpTestClient,
  setupReleaseCatalogTestSuite,
} from "@hot-updater/test-utils";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import {
  cleanupServer,
  createTestDbPath,
  killPort,
  spawnServerProcess,
  TEST_ADMIN_AUTH_TOKEN,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Elysia)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbPath: string;
  const port = 13580;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    testDbPath = createTestDbPath(projectRoot);
    await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

    process.env.TEST_DB_PATH = testDbPath;

    baseUrl = `http://localhost:${port}`;

    // Run database migrations before starting server
    const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
    const hotUpdaterCli = path.join(
      path.dirname(hotUpdaterPkgPath),
      "dist/index.mjs",
    );

    // Generate Drizzle schema from hotUpdater instance
    await execa(
      "node",
      [hotUpdaterCli, "db", "generate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath },
      },
    );

    // Apply schema to database using drizzle-kit
    await execa("npx", ["drizzle-kit", "push"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath },
    });

    // Write the settings rows the server checks before its first read
    await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath },
      },
    );

    serverProcess = spawnServerProcess({
      serverCommand: ["pnpm", "exec", "tsx", "src/index.ts"],
      port,
      testDbPath,
      projectRoot,
    });

    await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds
  }, 60000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, testDbPath);
  }, 60000);

  const getClient = () =>
    createHttpTestClient({
      clientBaseUrl: `${baseUrl}/hot-updater`,
      adminBaseUrl: `${baseUrl}/hot-updater/admin`,
      adminHeaders: { Authorization: `Bearer ${TEST_ADMIN_AUTH_TOKEN}` },
    });

  setupBundleMethodsTestSuite({ getClient });

  setupReleaseCatalogTestSuite({ getClient });

  it("rolls back a lazy Insights event whose head update fails, then records the retry", async () => {
    const { db, client } = await import("./drizzle.js");
    const insights = createInsightsModel(
      createDatabasePluginApis(
        drizzleAdapter({ db: async () => db, provider: "sqlite" }),
        [insightsPlugin()],
      ).insights,
    );
    const previous = {
      id: "00000000-0000-7000-8000-000000009880",
      type: "UPDATE_APPLIED" as const,
      install_id: "install-9880",
      user_id: null,
      from_release_id: null,
      from_bundle_id: "00000000-0000-7000-8000-000000009878",
      to_release_id: null,
      to_bundle_id: "00000000-0000-7000-8000-000000009879",
      platform: "ios" as const,
      app_version: "1.0.0",
      channel: "production",
      metadata: {
        username: null,
        cohort: "0",
        update_strategy: "appVersion" as const,
        fingerprint_hash: null,
        sdk_version: null,
      },
      received_at_ms: 100,
    };
    const next = {
      ...previous,
      id: "00000000-0000-7000-8000-000000009881",
      received_at_ms: 200,
    };
    await insights.recordEvent({ event: previous });
    // The installation's head exists, so the second event updates it.
    await client.execute(
      "CREATE TRIGGER reject_test_head BEFORE UPDATE ON bundle_event_heads WHEN new.received_at_ms = 200 BEGIN SELECT raise(abort, 'injected head failure'); END",
    );
    try {
      await expect(insights.recordEvent({ event: next })).rejects.toThrow();
      expect(
        (
          await client.execute({
            sql: "SELECT id FROM bundle_events WHERE id = ?",
            args: [next.id],
          })
        ).rows,
      ).toEqual([]);
      await expect(
        insights.findLatestEvents({ installId: previous.install_id }),
      ).resolves.toEqual([previous]);
    } finally {
      await client.execute("DROP TRIGGER reject_test_head");
    }
    await insights.recordEvent({ event: next });
    await insights.recordEvent({
      event: { ...next, received_at_ms: 300, user_id: "incorrect-user" },
    });
    await expect(
      insights.findLatestEvents({ installId: previous.install_id }),
    ).resolves.toEqual([next]);
  });

  it("keeps the client handler reachable without admin credentials", async () => {
    const response = await fetch(`${baseUrl}/hot-updater/version`);

    expect(response.status).toBe(200);
  });

  it.each([
    ["missing", undefined],
    ["incorrect", "Bearer incorrect-token"],
  ])("rejects %s admin credentials", async (_label, authorization) => {
    const response = await fetch(`${baseUrl}/hot-updater/admin/channels`, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });

    expect(response.status).toBe(401);
  });

  it("allows authenticated admin requests without caching", async () => {
    const response = await fetch(`${baseUrl}/hot-updater/admin/channels`, {
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_AUTH_TOKEN}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
