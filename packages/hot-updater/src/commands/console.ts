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

export type ConsoleCommandOptions = {
  config?: string;
  host?: string;
  port?: number;
  public?: boolean;
};

export type ConsoleLaunchOptions = {
  configPath?: string;
  host?: string;
  port: number;
  shouldWarnExternalAuth: boolean;
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

export const getConsolePort = async (
  config?: Pick<ConfigResponse, "console">,
  configPath?: string,
) => {
  if (config?.console.port) {
    return config.console.port;
  }

  const $config = await loadConfig(null, { configPath });
  return $config.console.port;
};

export const resolveConsoleLaunchOptions = async (
  options: ConsoleCommandOptions,
  config?: Pick<ConfigResponse, "console">,
): Promise<ConsoleLaunchOptions> => {
  const host = options.public ? "0.0.0.0" : (options.host ?? "127.0.0.1");
  const shouldWarnExternalAuth =
    options.public === true || host === "0.0.0.0" || host === "::";

  return {
    configPath: options.config,
    host,
    port: options.port ?? (await getConsolePort(config, options.config)),
    shouldWarnExternalAuth,
  };
};

export const openConsole = async (
  options: number | ConsoleLaunchOptions,
  listeningListener?: ((info: { port: number }) => void) | undefined,
) => {
  const launchOptions: ConsoleLaunchOptions =
    typeof options === "number"
      ? {
          port: options,
          host: "127.0.0.1",
          shouldWarnExternalAuth: false,
        }
      : options;
  const require = createRequire(import.meta.url);
  const consolePkgPath = require.resolve("@hot-updater/console/package.json");
  const consoleDir = path.dirname(consolePkgPath);
  const serveBinPath = path.join(consoleDir, "bin", "serve.mjs");
  const serveArgs = [
    serveBinPath,
    "--host",
    launchOptions.host ?? "127.0.0.1",
    "--port",
    launchOptions.port.toString(),
    ...(launchOptions.configPath ? ["--config", launchOptions.configPath] : []),
  ];

  const child = execa("node", serveArgs, {
    env: {
      ...process.env,
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
    await waitForConsoleReady({ child, port: launchOptions.port });
    listeningListener?.({ port: launchOptions.port });
  } catch (error) {
    cleanupProcessListeners();
    stopChild("SIGTERM");
    throw error;
  }
};
