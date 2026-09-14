import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildDetoxControlServerEnv,
  resolveControlBaseUrl,
  type DetoxPlatform,
} from "./control-server-env.ts";
import {
  monitorControlServerChild,
  stopControlServerChild,
  waitForControlServer,
} from "./control-server-lifecycle.ts";

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
  const startupNonce = randomUUID();
  serverEnv.HOT_UPDATER_E2E_CONTROL_SERVER_NONCE = startupNonce;
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
    },
  );
  const childMonitor = monitorControlServerChild(child);

  try {
    await waitForControlServer(controlBaseUrl, startupNonce, childMonitor);
  } catch (error) {
    try {
      await stopControlServerChild(child, childMonitor);
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        "Detox control server failed to start and close",
      );
    }
    throw error;
  }

  return {
    baseUrl: controlBaseUrl,
    stop: async () => {
      await fetchIgnoringFailure(`${controlBaseUrl}/e2e/cleanup`, {
        method: "POST",
      });
      await fetchIgnoringFailure(`${controlBaseUrl}/shutdown`, {
        method: "POST",
      });
      await stopControlServerChild(child, childMonitor);
    },
  };
}
