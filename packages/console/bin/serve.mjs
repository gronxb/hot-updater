#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "1422";

const printHelp = () => {
  console.log(`Usage: hot-updater-console [options]

Run the Hot Updater console server.

Options:
  --host <host>     Host to bind the console server (default: 127.0.0.1)
  --port <port>     Port to bind the console server (default: 1422)
  --config <path>   Path to hot-updater.config file
  -h, --help        Display help`);
};

const readValue = (args, index, option) => {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

const parseArgs = (args) => {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      return { help: true };
    }

    if (arg === "--host") {
      options.host = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
      continue;
    }

    if (arg === "--port") {
      options.port = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--port=")) {
      options.port = arg.slice("--port=".length);
      continue;
    }

    if (arg === "--config") {
      options.configPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
};

const resolveConfigPath = async (configPath) => {
  if (!configPath) {
    return undefined;
  }

  const resolvedPath = path.resolve(configPath);
  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Config path is not a file: ${resolvedPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes(resolvedPath)) {
      throw error;
    }
    throw new Error(`Config path does not exist: ${resolvedPath}`);
  }

  return resolvedPath;
};

const isLoopbackHost = (host) =>
  host === "127.0.0.1" || host === "localhost" || host === "::1";

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (options.help) {
  printHelp();
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", ".output", "server", "index.mjs");
const host = options.host ?? process.env.HOST ?? process.env.NITRO_HOST ?? DEFAULT_HOST;
const port = options.port ?? process.env.PORT ?? process.env.NITRO_PORT ?? DEFAULT_PORT;
const configPath = await resolveConfigPath(
  options.configPath ?? process.env.HOT_UPDATER_CONFIG_PATH,
);

if (configPath) {
  process.env.HOT_UPDATER_CONFIG_PATH = configPath;
}
process.env.HOST = host;
process.env.NITRO_HOST = host;
process.env.PORT = port;
process.env.NITRO_PORT = port;

const authMessage = isLoopbackHost(host)
  ? ""
  : " Protect this origin with external authentication.";
console.log(
  `Hot Updater console listening on http://${host}:${port}.${authMessage}`,
);

await import(pathToFileURL(serverPath).href);
