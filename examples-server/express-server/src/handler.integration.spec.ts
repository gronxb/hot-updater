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

describe("Hot Updater Handler Integration Tests (Express)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbPath: string;
  const port = 13581;

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

    // Generate Prisma Client first from existing schema
    await execa("npx", ["prisma", "generate"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
    });

    // Generate Prisma schema from hotUpdater instance
    await execa(
      "node",
      [hotUpdaterCli, "db", "generate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath },
      },
    );

    // Apply schema to database using prisma db push
    await execa("npx", ["prisma", "db", "push", "--skip-generate"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
    });

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath,
      projectRoot,
    });

    await waitForServer(baseUrl, 60); // 60 attempts * 200ms = 12 seconds
  }, 60000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, testDbPath);
  }, 60000);

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
