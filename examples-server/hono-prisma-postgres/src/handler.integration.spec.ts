import {
  cleanupServer,
  createGetUpdateInfo,
  createTestDbPath,
  killPort,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { execa } from "execa";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Hono + Prisma + PostgreSQL)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbName: string;
  const port = 13583;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    // Generate unique test database name
    testDbName = `hot_updater_test_${Date.now()}`;
    const testDatabaseUrl = `postgresql://hot_updater:hot_updater_dev@localhost:5433/${testDbName}`;

    baseUrl = `http://localhost:${port}`;

    // Ensure Docker Compose is running
    await execa("docker-compose", ["up", "-d"], {
      cwd: projectRoot,
    });

    // Wait for PostgreSQL to be ready
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Create test database
    await execa(
      "docker",
      [
        "exec",
        "hono-prisma-postgres",
        "psql",
        "-U",
        "hot_updater",
        "-c",
        `CREATE DATABASE ${testDbName};`,
      ],
      {
        cwd: projectRoot,
      },
    );

    // Run database migrations before starting server
    const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
    const hotUpdaterCli = path.join(
      path.dirname(hotUpdaterPkgPath),
      "dist/index.js",
    );

    // Generate Prisma Client first from existing schema
    await execa("npx", ["prisma", "generate"], {
      cwd: projectRoot,
      env: { DATABASE_URL: testDatabaseUrl },
    });

    // Generate Prisma schema from hotUpdater instance
    await execa(
      "node",
      [hotUpdaterCli, "db", "generate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DATABASE_URL: testDatabaseUrl },
      },
    );

    // Apply schema to database using prisma db push
    await execa("npx", ["prisma", "db", "push", "--skip-generate"], {
      cwd: projectRoot,
      env: { DATABASE_URL: testDatabaseUrl },
    });

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "",
      projectRoot,
      env: { TEST_DATABASE_URL: testDatabaseUrl },
    });

    await waitForServer(baseUrl, 60); // 60 attempts * 200ms = 12 seconds
  }, 120000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, "");

    // Drop test database
    try {
      await execa(
        "docker",
        [
          "exec",
          "hono-prisma-postgres",
          "psql",
          "-U",
          "hot_updater",
          "-c",
          `DROP DATABASE IF EXISTS ${testDbName};`,
        ],
        {
          cwd: projectRoot,
        },
      );
    } catch (error) {
      console.error("Failed to drop test database:", error);
    }
  }, 60000);

  const getUpdateInfo: ReturnType<typeof createGetUpdateInfo> = (
    bundles,
    options,
  ) => {
    return createGetUpdateInfo({
      baseUrl: `${baseUrl}/hot-updater`,
    })(bundles, options);
  };

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
  });
});
