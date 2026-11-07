import { randomBytes } from "node:crypto";
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

/**
 * The variable the console server reads its per-run session secret from,
 * and the query parameter of the link that hands it to the browser, as
 * `@hot-updater/console` names them.
 */
const CONSOLE_SESSION_ENV = "HOT_UPDATER_CONSOLE_SESSION";
const CONSOLE_SESSION_PARAM = "hot-updater-session";

/**
 * `url` on the console with the run's session secret, which the console
 * trades for a cookie: the link to open it with.
 */
export const withConsoleSession = (url: string | URL, session: string) => {
  const sessionUrl = new URL(url);
  sessionUrl.searchParams.set(CONSOLE_SESSION_PARAM, session);
  return sessionUrl.toString();
};

export const getConsoleServerEnv = (
  port: number,
  session: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  ...processEnv,
  PORT: port.toString(),
  NITRO_PORT: port.toString(),
  NITRO_HOST: "127.0.0.1",
  [CONSOLE_SESSION_ENV]: session,
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

/**
 * Starts the console on `port`, on this machine only, with a session
 * secret of its own: `listeningListener` gets it once the console answers,
 * to open it with `withConsoleSession`. The console serves no page or
 * server function to a browser without it.
 */
export const openConsole = async (
  port: number,
  listeningListener?:
    | ((info: { port: number; session: string }) => void)
    | undefined,
) => {
  const session = randomBytes(32).toString("base64url");
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
    env: getConsoleServerEnv(port, session),
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
    listeningListener?.({ port, session });
  } catch (error) {
    cleanupProcessListeners();
    stopChild("SIGTERM");
    throw error;
  }
};
