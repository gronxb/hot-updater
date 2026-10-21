// @ts-check

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { runAction } from "./preview.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI gets the Console's address and the vault token as
 * `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN`, which load the
 * vault's deploy credentials, and the same token as
 * `HOT_UPDATER_SIGNING_TOKEN`, which `remoteSigning` sends to the Console.
 */
const env = process.env;

/** @param {string} message */
const escapeCommand = (message) =>
  message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");

const log = {
  /** @param {string} message */
  info: (message) => console.log(message),
  /** @param {string} message */
  notice: (message) => console.log(`::notice::${escapeCommand(message)}`),
  /**
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} run
   */
  group: async (name, run) => {
    console.log(`::group::${escapeCommand(name)}`);
    try {
      return await run();
    } finally {
      console.log("::endgroup::");
    }
  },
};

/** @param {string} name @param {string} value */
const setOutput = (name, value) => {
  const file = env["GITHUB_OUTPUT"];
  if (!file) return;
  const delimiter = `hot-updater-${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
};

const readEvent = () => {
  const eventPath = env["GITHUB_EVENT_PATH"];
  const payload = eventPath
    ? JSON.parse(readFileSync(eventPath, "utf8"))
    : undefined;
  const pullRequest = payload?.pull_request;
  if (!pullRequest) {
    throw new Error(
      "Run the preview action on pull_request events: types opened, synchronize, reopened, and closed.",
    );
  }
  return {
    action: String(payload.action),
    number: Number(pullRequest.number),
    title: String(pullRequest.title ?? ""),
    headSha: String(pullRequest.head?.sha ?? env["GITHUB_SHA"] ?? ""),
  };
};

const token = env["INPUT_VAULT_TOKEN"]?.trim() ?? "";
if (token) console.log(`::add-mask::${token}`);
const cliEnv = {
  ...env,
  HOT_UPDATER_CONSOLE_URL: env["INPUT_CONSOLE_URL"]?.trim() ?? "",
  HOT_UPDATER_VAULT_TOKEN: token,
  HOT_UPDATER_SIGNING_TOKEN: env["HOT_UPDATER_SIGNING_TOKEN"] || token,
};
const cwd = path.resolve(
  env["GITHUB_WORKSPACE"] ?? process.cwd(),
  env["INPUT_WORKING_DIRECTORY"]?.trim() || ".",
);
const [command = "npx", ...prefix] = (
  env["INPUT_CLI"]?.trim() || "npx --no-install hot-updater"
).split(/\s+/);

/**
 * @param {string[]} args
 * @param {{ capture?: boolean }} [options]
 * @returns {Promise<{ code: number, stdout: string }>}
 */
const cli = (args, { capture = false } = {}) =>
  new Promise((resolve, reject) => {
    console.log(`$ hot-updater ${args.join(" ")}`);
    const child = spawn(command, [...prefix, ...args], {
      cwd,
      env: cliEnv,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (capture) {
        resolve({ code: code ?? 1, stdout });
      } else if (code === 0) {
        resolve({ code, stdout });
      } else {
        reject(new Error(`hot-updater ${args.join(" ")} exited with ${code}.`));
      }
    });
  });

const githubToken = env["INPUT_GITHUB_TOKEN"]?.trim();
const repository = env["GITHUB_REPOSITORY"];

try {
  await runAction(
    {
      cli,
      fetch,
      github:
        githubToken && repository
          ? {
              fetch,
              apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com",
              repository,
              token: githubToken,
            }
          : null,
      setOutput,
      log,
    },
    env,
    readEvent(),
  );
} catch (error) {
  console.log(
    `::error::${escapeCommand(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
}
