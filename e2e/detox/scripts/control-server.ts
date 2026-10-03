import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  buildDetoxControlServerEnv,
  resolveControlBaseUrl,
  type DetoxPlatform,
} from "./control-server-env.ts";

export {
  buildDetoxChildEnv,
  buildDetoxControlServerEnv,
} from "./control-server-env.ts";
export type { DetoxPlatform } from "./control-server-env.ts";

type ControlServerHandle = {
  readonly baseUrl: string;
  readonly stop: (options?: { cleanup?: boolean }) => Promise<void>;
};

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const resultsRoot = path.join(repoDir, "e2e/results/detox");

async function fetchIgnoringFailure(
  url: string,
  init?: RequestInit,
): Promise<void> {
  try {
    await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}

async function waitForControlServer(
  baseUrl: string,
  child: ChildProcess,
  options: { verifyProcess?: boolean; signal?: AbortSignal },
): Promise<void> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    options.signal?.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Control server exited before becoming ready");
    }
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        if (!options.verifyProcess) return;
        const health = (await response.json()) as { processId?: number };
        if (health.processId === child.pid) return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000, undefined, { signal: options.signal });
  }
  throw new Error(
    `Timed out waiting for Detox control server ${baseUrl}: ${lastError}`,
  );
}

async function stopChild(child: ChildProcess, detached = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (value: NodeJS.Signals) => {
    if (detached && child.pid) {
      try {
        process.kill(-child.pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else child.kill(value);
  };
  let forced = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      forced = true;
      signal("SIGKILL");
    }, 3000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    signal("SIGTERM");
  });
  if (forced) throw new Error("Control server required forced termination");
}

export async function startDetoxControlServer(
  platform: DetoxPlatform,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    detached?: boolean;
    verifyProcess?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ControlServerHandle> {
  if (env.CONTROL_URL || env.HOT_UPDATER_E2E_CONTROL_BASE_URL) {
    return {
      baseUrl: resolveControlBaseUrl(env),
      stop: async () => {},
    };
  }

  const serverEnv = buildDetoxControlServerEnv(platform, env);
  const controlBaseUrl = `http://${serverEnv.HOT_UPDATER_E2E_SERVER_HOST}:${serverEnv.PORT}`;
  await fs.mkdir(serverEnv.HOT_UPDATER_E2E_RESULTS_DIR ?? resultsRoot, {
    recursive: true,
  });

  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(repoDir, "e2e/detox/control-server/index.ts"),
    ],
    {
      cwd: repoDir,
      env: serverEnv,
      stdio: "inherit",
      detached: options.detached,
    },
  );

  try {
    await waitForControlServer(controlBaseUrl, child, options);
  } catch (error) {
    await stopChild(child, options.detached);
    throw error;
  }

  return {
    baseUrl: controlBaseUrl,
    stop: async (stopOptions) => {
      if (stopOptions?.cleanup !== false) {
        await fetchIgnoringFailure(`${controlBaseUrl}/e2e/cleanup`, {
          method: "POST",
        });
      }
      await fetchIgnoringFailure(`${controlBaseUrl}/shutdown`, {
        method: "POST",
      });
      await stopChild(child, options.detached);
    },
  };
}
