import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  type ConfigResponse,
  getCwd,
  loadConfig,
  loadVaultDeployCredentials,
  p,
  readLoadedHotUpdaterEnv,
  readVaultConnection,
  VAULT_CONNECTION_ENV_NAMES,
} from "@hot-updater/cli-tools";
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

export const getConsoleServerEnv = (
  port: number,
  processEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  ...processEnv,
  PORT: port.toString(),
  NITRO_PORT: port.toString(),
  NITRO_HOST: "127.0.0.1",
});

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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether `url` is the console this command starts on `port`. */
const isThisConsole = (url: string, port: number) => {
  try {
    const parsed = new URL(url);
    return (
      LOOPBACK_HOSTS.has(parsed.hostname) &&
      Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) === port
    );
  } catch {
    return false;
  }
};

/**
 * Sets the vault's deploy credentials in `process.env`, which the console's
 * server inherits as it loads the config, when the connection variables
 * name another Console. The console started on `port` cannot serve its own
 * database and storage credentials before it runs, so those stay in its
 * environment or `.env.hotupdater`.
 */
export const loadConsoleCredentials = async (port: number) => {
  const cwd = getCwd();
  const read = readVaultConnection(await readLoadedHotUpdaterEnv(cwd));
  if (read.ok && isThisConsole(read.connection.url, port)) {
    p.log.warn(
      `${VAULT_CONNECTION_ENV_NAMES.url} is this console (${read.connection.url}), which cannot serve the credentials it starts with: keep its database and storage credentials in the environment or .env.hotupdater.`,
    );
    return;
  }
  await loadVaultDeployCredentials(cwd);
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
    env: getConsoleServerEnv(port),
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
