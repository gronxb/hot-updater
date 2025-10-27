import {
  cleanupServer,
  createGetUpdateInfo,
  createTestDbPath,
  killPort,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import type { execa } from "execa";
import { afterAll, beforeAll, describe } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { execa as execaImport } from "execa";

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

    baseUrl = `http://localhost:${port}`;

    // Run database migrations before starting server
    // First generate SQL migration files
    await execaImport("pnpm", ["exec", "hot-updater", "generate-db", "src/db.ts"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath },
    });

    // Then apply migrations to database
    await execaImport("pnpm", ["exec", "hot-updater", "migrate-db", "src/db.ts"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath },
    });

    serverProcess = spawnServerProcess({
      serverCommand: ["pnpm", "exec", "tsx", "src/index.ts"],
      port,
      testDbPath,
      projectRoot,
    });

    await waitForServer(baseUrl);
  }, 60000);

  afterAll(async () => {
    await cleanupServer(serverProcess, testDbPath);
  });

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
