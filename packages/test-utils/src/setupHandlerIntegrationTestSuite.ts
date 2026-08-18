import fs from "fs/promises";
import path from "path";

import type { Bundle, LegacyBundle, Platform } from "@hot-updater/core";
import type {
  ChannelRow,
  ReleaseCatalogMutationResult,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { execa } from "execa";

export interface TestApiConfig {
  baseUrl: string;
  authToken?: string;
}

export const TEST_MANAGEMENT_AUTH_TOKEN = "hot-updater-test-token";

const createManagementHeaders = (config: TestApiConfig) => ({
  Authorization: `Bearer ${config.authToken ?? TEST_MANAGEMENT_AUTH_TOKEN}`,
});

const requireOk = async (response: Response, operation: string) => {
  if (!response.ok) {
    throw new Error(`${operation}: ${response.statusText}`);
  }
  return response;
};

const readData = async <T>(response: Response): Promise<T> => {
  const value = (await response.json()) as { data?: T };
  if (!("data" in value)) throw new Error("Missing response data.");
  return value.data as T;
};

export async function deleteLegacyBundleFromServer(
  config: TestApiConfig,
  bundleId: string,
): Promise<void> {
  const buildUrl = (path: string) => `${config.baseUrl}${path}`;
  const headers = createManagementHeaders(config);

  for (;;) {
    const releasesUrl = new URL(buildUrl("/api/releases"));
    releasesUrl.searchParams.set("bundleId", bundleId);
    releasesUrl.searchParams.set("limit", "1000");
    const releases = await readData<readonly ReleaseRow[]>(
      await requireOk(
        await fetchWithRetry(releasesUrl, { headers }),
        "Failed to list Releases",
      ),
    );
    if (releases.length === 0) break;

    for (const release of releases) {
      let revision = release.revision;
      if (release.enabled) {
        const result = await readData<ReleaseCatalogMutationResult>(
          await requireOk(
            await fetchWithRetry(
              buildUrl(`/api/releases/${encodeURIComponent(release.id)}`),
              {
                body: JSON.stringify({
                  expectedRevision: revision,
                  patch: { enabled: false },
                }),
                headers: { ...headers, "Content-Type": "application/json" },
                method: "PATCH",
              },
            ),
            "Failed to disable Release",
          ),
        );
        if (result.release === null) {
          throw new Error(`Release "${release.id}" was not updated.`);
        }
        revision = result.release.revision;
      }

      const deleteUrl = new URL(
        buildUrl(`/api/releases/${encodeURIComponent(release.id)}`),
      );
      deleteUrl.searchParams.set("confirm", release.id);
      deleteUrl.searchParams.set("expectedRevision", String(revision));
      await requireOk(
        await fetchWithRetry(deleteUrl, { headers, method: "DELETE" }),
        "Failed to delete Release",
      );
    }
  }

  await requireOk(
    await fetchWithRetry(
      buildUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
      { headers, method: "DELETE" },
    ),
    "Failed to delete Bundle",
  );
}

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

export function createBundleMethodsFromServer(config: TestApiConfig) {
  const buildUrl = (path: string) => `${config.baseUrl}${path}`;
  const headers = createManagementHeaders(config);

  return {
    getBundleById: async (id: string): Promise<Bundle | null> => {
      const response = await fetchWithRetry(
        buildUrl(`/api/bundles/${encodeURIComponent(id)}`),
        { headers },
      );
      if (response.status === 404) return null;
      const okResponse = await requireOk(response, "Failed to get Bundle");
      return (await okResponse.json()) as Bundle;
    },
    getChannels: async (): Promise<readonly ChannelRow[]> => {
      const response = await requireOk(
        await fetchWithRetry(buildUrl("/api/channels"), { headers }),
        "Failed to get Channels",
      );
      const body = (await response.json()) as {
        data: { channels: readonly ChannelRow[] };
      };
      return body.data.channels;
    },
    insertBundle: async (bundle: LegacyBundle): Promise<void> => {
      await requireOk(
        await fetchWithRetry(buildUrl("/api/bundles"), {
          body: JSON.stringify(bundle),
          headers: { ...headers, "Content-Type": "application/json" },
          method: "POST",
        }),
        "Failed to insert Bundle",
      );
    },
    getBundles: async (options: {
      readonly where?: {
        readonly platform?: Platform;
        readonly id?: { readonly eq?: string; readonly in?: string[] };
      };
      readonly limit: number;
      readonly cursor?: { readonly after: string };
      readonly orderBy?: {
        readonly field: "id";
        readonly direction: "asc" | "desc";
      };
    }) => {
      const url = new URL(buildUrl("/api/bundles"));
      url.searchParams.set("limit", String(Math.min(options.limit, 100)));
      if (options.where?.platform) {
        url.searchParams.set("platform", options.where.platform);
      }
      if (options.where?.id?.eq) {
        url.searchParams.set("idEq", options.where.id.eq);
      }
      for (const id of options.where?.id?.in ?? []) {
        url.searchParams.append("idIn", id);
      }
      if (options.cursor?.after) {
        url.searchParams.set("after", options.cursor.after);
      }
      if (options.orderBy) {
        url.searchParams.set("orderDirection", options.orderBy.direction);
      }
      const response = await requireOk(
        await fetchWithRetry(url, { headers }),
        "Failed to get Bundles",
      );
      return (await response.json()) as {
        readonly data: Bundle[];
        readonly pagination: {
          readonly total: number;
          readonly hasNextPage: boolean;
          readonly hasPreviousPage: boolean;
          readonly currentPage: number;
          readonly totalPages: number;
          readonly nextCursor?: string | null;
        };
      };
    },
    updateBundleById: async (
      bundleId: string,
      patch: Partial<Bundle>,
    ): Promise<void> => {
      await requireOk(
        await fetchWithRetry(
          buildUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
          {
            body: JSON.stringify(patch),
            headers: { ...headers, "Content-Type": "application/json" },
            method: "PATCH",
          },
        ),
        "Failed to update Bundle",
      );
    },
    deleteBundleById: (bundleId: string) =>
      deleteLegacyBundleFromServer(config, bundleId),
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
