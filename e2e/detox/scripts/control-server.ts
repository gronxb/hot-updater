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
  readonly stop: () => Promise<void>;
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

async function waitForControlServer(baseUrl: string): Promise<void> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for Detox control server ${baseUrl}: ${lastError}`,
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    setTimeout(() => resolve(), 3000);
  });
}

export async function startDetoxControlServer(
  platform: DetoxPlatform,
  env: NodeJS.ProcessEnv = process.env,
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
      path.join(repoDir, "e2e/maestro/server/index.ts"),
    ],
    {
      cwd: repoDir,
      env: serverEnv,
      stdio: "inherit",
    },
  );

  await waitForControlServer(controlBaseUrl);

  return {
    baseUrl: controlBaseUrl,
    stop: async () => {
      await fetchIgnoringFailure(`${controlBaseUrl}/e2e/cleanup`, {
        method: "POST",
      });
      await fetchIgnoringFailure(`${controlBaseUrl}/shutdown`, {
        method: "POST",
      });
      await stopChild(child);
    },
  };
}
