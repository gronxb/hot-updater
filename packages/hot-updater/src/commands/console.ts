import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import { execa } from "execa";

const CONSOLE_READY_TIMEOUT_MS = 15_000;
const CONSOLE_READY_POLL_INTERVAL_MS = 200;
const CONSOLE_READY_REQUEST_TIMEOUT_MS = 1_000;

type ConsoleProcessState = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

type WaitForConsoleReadyOptions = {
  child: ConsoleProcessState;
  port: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  checkReady?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<unknown>;
};

const getConsoleServerUrl = (port: number) => `http://127.0.0.1:${port}`;

export const isConsoleServerReady = async (port: number) => {
  try {
    const response = await fetch(getConsoleServerUrl(port), {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(CONSOLE_READY_REQUEST_TIMEOUT_MS),
    });

    await response.body?.cancel();

    return response.status >= 100;
  } catch {
    return false;
  }
};

export const waitForConsoleReady = async ({
  child,
  port,
  timeoutMs = CONSOLE_READY_TIMEOUT_MS,
  pollIntervalMs = CONSOLE_READY_POLL_INTERVAL_MS,
  checkReady = isConsoleServerReady,
  sleep = delay,
}: WaitForConsoleReadyOptions) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.signalCode) {
      throw new Error(
        `Console server exited before it became ready (signal: ${child.signalCode}).`,
      );
    }

    if (child.exitCode !== null) {
      throw new Error(
        `Console server exited before it became ready (exit code: ${child.exitCode}).`,
      );
    }

    if (await checkReady(port)) {
      return;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for the console server on port ${port}.`);
};

export const getConsolePort = async (config?: ConfigResponse) => {
  if (config?.console.port) {
    return config.console.port;
  }

  const $config = await loadConfig(null);
  return $config.console.port;
};

export const openConsole = async (
  port: number,
  listeningListener?: ((info: { port: number }) => void) | undefined,
) => {
  const require = createRequire(import.meta.url);
  const consolePkgPath = require.resolve("@hot-updater/console/package.json");
  const consoleDir = path.dirname(consolePkgPath);
  const nitroServerPath = path.join(
    consoleDir,
    ".output",
    "server",
    "index.mjs",
  );

  const child = execa("node", [nitroServerPath], {
    env: {
      ...process.env,
      PORT: port.toString(),
      NITRO_PORT: port.toString(),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  let isShuttingDown = false;

  const stopChild = (signal: NodeJS.Signals) => {
    isShuttingDown = true;
    child.kill(signal);
  };

  const handleSigint = () => {
    stopChild("SIGINT");
    process.exit(0);
  };

  const handleSigterm = () => {
    stopChild("SIGTERM");
    process.exit(0);
  };

  const cleanupProcessListeners = () => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  child.once("exit", cleanupProcessListeners);
  child.once("error", cleanupProcessListeners);

  void child.catch((err) => {
    if (isShuttingDown) {
      return;
    }

    console.error("Console server exited unexpectedly:", err);
  });

  try {
    await waitForConsoleReady({ child, port });
    listeningListener?.({ port });
  } catch (error) {
    cleanupProcessListeners();
    stopChild("SIGTERM");
    throw error;
  }
};
