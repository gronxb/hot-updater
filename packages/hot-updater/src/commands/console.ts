import { createRequire } from "node:module";
import path from "node:path";
import { type ConfigResponse, loadConfig } from "@hot-updater/cli-tools";
import { execa } from "execa";

const READY_LOG_TOKEN = "Listening on";

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
    stdout: "pipe",
    stderr: "inherit",
  });

  let startupOutputBuffer = "";
  let hasReportedReady = false;

  child.stdout?.on("data", (data: Buffer) => {
    const output = data.toString();
    process.stdout.write(output);

    if (hasReportedReady) {
      return;
    }

    startupOutputBuffer = `${startupOutputBuffer}${output}`.slice(
      -READY_LOG_TOKEN.length * 2,
    );

    if (startupOutputBuffer.includes(READY_LOG_TOKEN)) {
      hasReportedReady = true;
      listeningListener?.({ port });
    }
  });

  child.on("error", (err) => {
    console.error("Failed to start console server:", err);
  });

  void child.catch((err) => {
    console.error("Console server exited unexpectedly:", err);
  });

  process.on("SIGINT", () => {
    child.kill("SIGINT");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
    process.exit(0);
  });
};
