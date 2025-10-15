import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";

/**
 * Creates getUpdateInfo function for integration tests
 * This is used with setupGetUpdateInfoTestSuite from @hot-updater/core/test-utils
 */
export function createGetUpdateInfo(
  baseUrl: string,
): (bundles: Bundle[], options: GetBundlesArgs) => Promise<UpdateInfo | null> {
  return async (bundles, options) => {
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

      const data = (await response.json()) as
        | { update: false }
        | ({ update: true; fileUrl?: string } & UpdateInfo);

      // Step 4: Clean up via DELETE /api/bundles/:id
      for (const bundle of bundles) {
        await fetch(`${baseUrl}/api/bundles/${bundle.id}`, {
          method: "DELETE",
        });
      }

      // Return UpdateInfo or null
      if (data.update) {
        return {
          id: data.id,
          message: data.message,
          shouldForceUpdate: data.shouldForceUpdate,
          status: data.status,
          storageUri: data.storageUri,
        };
      }

      return null;
    } catch (error) {
      console.error("getUpdateInfo error:", error);
      throw error;
    }
  };
}

/**
 * Kills any process using the specified port
 */
export async function killPort(port: number): Promise<void> {
  try {
    const { stdout } = await execa("lsof", ["-ti", `:${port}`], {
      reject: false,
    });

    if (stdout.trim()) {
      await execa("kill", ["-9", stdout.trim()]);
      // Wait a bit for the port to be released
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // Ignore errors - port might not be in use
  }
}

/**
 * Helper to wait for server to be ready
 */
export async function waitForServer(
  url: string,
  maxAttempts = 30,
): Promise<void> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (e) {
      lastError = e as Error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `Server did not start within ${maxAttempts * 200}ms. Last error: ${lastError?.message || "Unknown"}`,
  );
}

/**
 * Creates test database path with timestamp isolation
 */
export function createTestDbPath(projectRoot: string): string {
  return path.join(projectRoot, "data", `snapshot-${Date.now()}`);
}

/**
 * Spawns a server process for testing
 */
export function spawnServerProcess(options: {
  serverCommand: string[];
  port: number;
  testDbPath: string;
  projectRoot: string;
  env?: Record<string, string>;
}): ReturnType<typeof execa> {
  const { serverCommand, port, testDbPath, projectRoot, env = {} } = options;

  const serverProcess = execa(serverCommand[0], serverCommand.slice(1), {
    env: {
      ...process.env,
      PORT: String(port),
      TEST_DB_PATH: testDbPath,
      // Use test credentials for AWS
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      AWS_BUCKET_NAME: "test-bucket",
      ...env,
    },
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Pipe stdout/stderr for debugging
  if (serverProcess.stdout) {
    serverProcess.stdout.on("data", (data) => {
      console.log(`[server] ${data.toString()}`);
    });
  }
  if (serverProcess.stderr) {
    serverProcess.stderr.on("data", (data) => {
      console.error(`[server] ${data.toString()}`);
    });
  }

  return serverProcess;
}

/**
 * Cleans up server process and test database
 */
export async function cleanupServer(
  serverProcess: ReturnType<typeof execa> | null,
  testDbPath: string,
): Promise<void> {
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
}
