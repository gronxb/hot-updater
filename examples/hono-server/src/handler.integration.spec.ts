import {
  cleanupServer,
  createGetUpdateInfo,
  createTestDbPath,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/server/test-utils";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import type { execa } from "execa";
import { afterAll, beforeAll, describe } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

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
    testDbPath = createTestDbPath(projectRoot);
    await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

    baseUrl = `http://localhost:${port}`;

    serverProcess = spawnServerProcess({
      serverCommand: ["tsx", "src/index.ts"],
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
    return createGetUpdateInfo(baseUrl)(bundles, options);
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });
});
