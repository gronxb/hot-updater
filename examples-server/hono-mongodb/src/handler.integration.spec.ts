import {
  cleanupServer,
  createGetUpdateInfo,
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

describe("Hot Updater Handler Integration Tests (Hono + MongoDB)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbName: string;
  const port = 13585;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    // Generate unique test database name
    testDbName = `hot_updater_test_${Date.now()}`;
    const testMongoUrl = `mongodb://hot_updater:hot_updater_dev@localhost:27018/${testDbName}?authSource=admin`;

    baseUrl = `http://localhost:${port}`;

    // Ensure Docker Compose is running
    await execa("docker", ["compose", "up", "-d"], {
      cwd: projectRoot,
    });

    // Wait for MongoDB to be ready
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Run database migrations
    await execa(
      "npx",
      ["hot-updater", "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_MONGODB_URL: testMongoUrl },
      },
    );

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "",
      projectRoot,
      env: { TEST_MONGODB_URL: testMongoUrl },
    });

    await waitForServer(baseUrl, 60); // 60 attempts * 200ms = 12 seconds
  }, 120000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, "");

    // Stop and remove Docker containers
    await execa("docker", ["compose", "down", "-v"], {
      cwd: projectRoot,
    });
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
