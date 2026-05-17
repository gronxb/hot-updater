import fs from "fs/promises";
import path from "path";

import type { AppUpdateInfo, Bundle, GetBundlesArgs } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { execa } from "execa";

export interface TestApiConfig {
  baseUrl: string;
  authToken?: string;
}

export const TEST_MANAGEMENT_AUTH_TOKEN = "hot-updater-test-token";

const createManagementHeaders = (config: TestApiConfig) => ({
  Authorization: `Bearer ${config.authToken ?? TEST_MANAGEMENT_AUTH_TOKEN}`,
});

async function fetchWithRetry(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }

  throw lastError;
}

/**
 * Creates getUpdateInfo function for integration tests
 * This is used with setupGetUpdateInfoTestSuite from @hot-updater/test-utils
 */
export function createGetUpdateInfo(
  config: TestApiConfig,
): (
  bundles: Bundle[],
  options: GetBundlesArgs,
) => Promise<AppUpdateInfo | null> {
  // Single source URL builder
  const buildUrl = (path: string) => `${config.baseUrl}${path}`;
  const managementHeaders = createManagementHeaders(config);

  return async (bundles, options) => {
    try {
      // Step 1: Create bundles via POST
      for (const bundle of bundles) {
        const createResponse = await fetchWithRetry(buildUrl("/api/bundles"), {
          method: "POST",
          headers: {
            ...managementHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bundle),
        });

        if (!createResponse.ok) {
          throw new Error(
            `Failed to create bundle: ${createResponse.statusText}`,
          );
        }
      }

      // Step 2: List bundles via GET
      const listResponse = await fetchWithRetry(buildUrl("/api/bundles"), {
        headers: {
          ...managementHeaders,
          "Content-Type": "application/json",
        },
      });

      if (!listResponse.ok) {
        throw new Error(`Failed to list bundle: ${listResponse.statusText}`);
      }

      // Step 3: Construct GET URL based on updateStrategy
      const channel = options.channel || "production";
      const minBundleId = options.minBundleId || NIL_UUID;
      const cohort = encodeURIComponent(options.cohort ?? "1");

      let url: string;
      if (options._updateStrategy === "appVersion") {
        url = buildUrl(
          `/app-version/${options.platform}/${options.appVersion}/${channel}/${minBundleId}/${options.bundleId}/${cohort}`,
        );
      } else {
        url = buildUrl(
          `/fingerprint/${options.platform}/${options.fingerprintHash}/${channel}/${minBundleId}/${options.bundleId}/${cohort}`,
        );
      }

      // Step 4: Check for updates via GET
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        throw new Error(`Failed to check for updates: ${response.statusText}`);
      }

      const data = (await response.json()) as AppUpdateInfo | null;

      // Step 5: Clean up via DELETE
      for (const bundle of bundles) {
        await fetchWithRetry(buildUrl(`/api/bundles/${bundle.id}`), {
          method: "DELETE",
          headers: managementHeaders,
        });
      }

      return data;
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
      NODE_ENV: "test",
      HOT_UPDATER_AUTH_TOKEN: TEST_MANAGEMENT_AUTH_TOKEN,
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
  baseUrl: string,
  serverProcess: ReturnType<typeof execa> | null,
  testDbPath: string,
): Promise<void> {
  // 1. Call shutdown endpoint to gracefully close database
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(`${baseUrl}/shutdown`, {
      method: "POST",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Wait for server to shut down gracefully
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    // Shutdown endpoint failed, will fallback to SIGTERM
    console.warn("Shutdown endpoint failed:", error);
  }

  // 2. If process is still alive, force kill it
  if (serverProcess) {
    try {
      serverProcess.kill("SIGTERM");

      // Wait up to 5 seconds for graceful shutdown
      await Promise.race([
        serverProcess,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // If still running, force kill
      try {
        serverProcess.kill("SIGKILL");
        await serverProcess.catch(() => {});
      } catch {
        // Process already dead
      }
    }
  }

  // 3. Wait for database file locks to be released
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 4. Clean up test database
  try {
    await fs.rm(testDbPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
