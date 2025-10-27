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
import fs from "fs/promises";
import { execa } from "execa";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Hono)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbPath: string;
  const port = 13579;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    testDbPath = createTestDbPath(projectRoot);
    await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

    baseUrl = `http://localhost:${port}`;

    // Run database migrations before starting server
    const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
    const hotUpdaterCli = path.join(
      path.dirname(hotUpdaterPkgPath),
      "dist/index.js",
    );

    // First generate SQL migration files
    await execa("node", [hotUpdaterCli, "generate-db", "src/db.ts", "--yes"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath },
    });

    // Then apply migrations to database
    await execa("node", [hotUpdaterCli, "migrate-db", "src/db.ts", "--yes"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath },
    });

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath,
      projectRoot,
    });

    await waitForServer(baseUrl);
  }, 120000);

  afterAll(async () => {
    await cleanupServer(serverProcess, testDbPath);
  }, 120000);

  const getUpdateInfo: ReturnType<typeof createGetUpdateInfo> = (
    bundles,
    options,
  ) => {
    return createGetUpdateInfo({
      baseUrl: `${baseUrl}/hot-updater`,
    })(bundles, options);
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });
});
