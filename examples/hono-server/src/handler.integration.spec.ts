import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { execa } from "execa";
import { afterAll, beforeAll, describe } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests", () => {
  let serverProcess: ReturnType<typeof execa>;
  let baseUrl: string;
  let testDbPath: string;
  const port = 13579; // Use fixed port for testing

  // Helper function to wait for server to be ready
  const waitForServer = async (url: string, maxAttempts = 30) => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Server did not start within ${maxAttempts * 200}ms`);
  };

  beforeAll(async () => {
    // Use "data/snapshot-{timestamp}" for test database isolation
    testDbPath = path.join(projectRoot, "data", `snapshot-${Date.now()}`);

    // Ensure data directory exists
    await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

    baseUrl = `http://localhost:${port}`;

    // Spawn server process with execa
    serverProcess = execa("tsx", ["src/index.ts"], {
      env: {
        PORT: String(port),
        TEST_DB_PATH: testDbPath,
        // Use test credentials for AWS
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_BUCKET_NAME: "test-bucket",
      },
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Pipe stdout/stderr for debugging (optional)
    if (serverProcess.stdout) {
      serverProcess.stdout.on("data", (data) => {
        // console.log(`[server] ${data.toString()}`);
      });
    }
    if (serverProcess.stderr) {
      serverProcess.stderr.on("data", (data) => {
        // console.error(`[server] ${data.toString()}`);
      });
    }

    // Wait for server to be ready
    await waitForServer(baseUrl);
  });

  afterAll(async () => {
    // Kill server process
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      try {
        await serverProcess;
      } catch {
        // Process was killed, expected
      }
    }

    // Clean up test database
    try {
      await fs.rm(testDbPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const getUpdateInfo = async (
    bundles: Bundle[],
    options: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    try {
      // Step 1: Create bundles via POST /api/bundles
      for (const bundle of bundles) {
        const createResponse = await fetch(`${baseUrl}/api/bundles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bundle),
        });

        if (!createResponse.ok) {
          throw new Error(
            `Failed to create bundle: ${createResponse.statusText}`,
          );
        }
      }

      // Step 2: Construct GET URL based on updateStrategy
      const channel = options.channel || "production";
      const minBundleId = options.minBundleId || NIL_UUID;

      let url: string;
      if (options._updateStrategy === "appVersion") {
        const appVersion = (options as any).appVersion;
        url = `${baseUrl}/api/app-version/${options.platform}/${appVersion}/${channel}/${minBundleId}/${options.bundleId}`;
      } else {
        const fingerprintHash = (options as any).fingerprintHash;
        url = `${baseUrl}/api/fingerprint/${options.platform}/${fingerprintHash}/${channel}/${minBundleId}/${options.bundleId}`;
      }

      // Step 3: Check for updates via GET
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to check for updates: ${response.statusText}`);
      }

      const data = await response.json();

      // Step 4: Clean up via DELETE /api/bundles/:id
      for (const bundle of bundles) {
        await fetch(`${baseUrl}/api/bundles/${bundle.id}`, {
          method: "DELETE",
        });
      }

      // Return UpdateInfo or null
      if (data.update) {
        // Remove the 'update' and 'fileUrl' fields to match UpdateInfo type
        const { update, fileUrl, ...updateInfo } = data;
        return updateInfo as UpdateInfo;
      }

      return null;
    } catch (error) {
      console.error("getUpdateInfo error:", error);
      throw error;
    }
  };

  // Use the shared test suite
  setupGetUpdateInfoTestSuite({ getUpdateInfo });
});
