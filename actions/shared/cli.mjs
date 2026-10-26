// @ts-check

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";

/**
 * What the actions share: GitHub's workflow commands and outputs, and the
 * project's hot-updater CLI, run in the app's directory.
 */

/** @param {string} message */
export const escapeCommand = (message) =>
  message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");

export const log = {
  /** @param {string} message */
  info: (message) => console.log(message),
  /** @param {string} message */
  notice: (message) => console.log(`::notice::${escapeCommand(message)}`),
  /** @param {string} message */
  error: (message) => console.log(`::error::${escapeCommand(message)}`),
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

/** Credential variables whose value is a secret as a whole. */
const CREDENTIAL_VARIABLES = new Set([
  "HOT_UPDATER_ASC_KEY",
  "HOT_UPDATER_ANDROID_KEYSTORE_BASE64",
  "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
  "HOT_UPDATER_ANDROID_KEY_PASSWORD",
  "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
]);

/**
 * Fields of a JSON credential that identify it rather than grant access, as
 * the CLI leaves them readable: a short alias such as `release` would mask
 * every word it is in.
 */
const IDENTIFIER_FIELDS = new Set([
  "keyId",
  "issuerId",
  "keyAlias",
  "type",
  "project_id",
  "client_email",
  "client_id",
  "universe_domain",
]);

/** @param {string} value @returns {Record<string, unknown> | undefined} */
const jsonObject = (value) => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The values to mask in the job's log among the credentials the job's
 * environment gives the CLI: the `HOT_UPDATER_*` credential variables, and
 * each `HOT_UPDATER_*` variable that holds a JSON credential, as the CLI
 * reads one per secret, whole and field by field but its identifiers. A
 * multi-line value is masked line by line, as GitHub masks one line.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export const credentialMasks = (env) => {
  /** @type {Set<string>} */
  const masks = new Set();
  /** @param {string} value */
  const add = (value) => {
    for (const line of value.split(/\r?\n/)) {
      // A PEM's armor lines are the same in every key.
      if (
        line.trim() &&
        !/^-----(BEGIN|END) [A-Z0-9 ]+-----$/.test(line.trim())
      ) {
        masks.add(line.trim());
      }
    }
  };
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("HOT_UPDATER_") || !value?.trim()) continue;
    const fields = jsonObject(value);
    if (CREDENTIAL_VARIABLES.has(name)) add(value);
    if (fields) {
      add(value);
      for (const [field, entry] of Object.entries(fields)) {
        if (typeof entry === "string" && !IDENTIFIER_FIELDS.has(field)) {
          add(entry);
        }
      }
    }
  }
  return [...masks];
};

/**
 * Tells GitHub to mask the credentials `env` gives the CLI.
 *
 * @param {Record<string, string | undefined>} env
 */
export const maskCredentials = (env) => {
  for (const value of credentialMasks(env)) {
    console.log(`::add-mask::${value}`);
  }
};

/**
 * Appends `value` to the file GitHub reads a step's `name` output from.
 *
 * @param {string} name
 * @param {string} value
 * @param {Record<string, string | undefined>} [env]
 */
export const setOutput = (name, value, env = process.env) => {
  const file = env["GITHUB_OUTPUT"];
  if (!file) return;
  const delimiter = `hot-updater-${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
};

/**
 * @typedef {(args: string[], options?: { capture?: boolean }) => Promise<{ code: number, stdout: string }>} Cli
 *   Runs the project's hot-updater CLI. Without `capture`, it prints the
 *   command's output and throws when the command fails; with it, it returns
 *   the output and the exit code.
 */

/**
 * The project's CLI as the `cli` input runs it, in the `working-directory`
 * input's directory, with `env`.
 *
 * @param {{ env: Record<string, string | undefined>, actionEnv?: Record<string, string | undefined> }} options
 *   `env` is the CLI's environment, and `actionEnv` the step's, with the
 *   inputs.
 * @returns {Cli}
 */
export const createCli = ({ env, actionEnv = process.env }) => {
  const cwd = path.resolve(
    actionEnv["GITHUB_WORKSPACE"] ?? process.cwd(),
    actionEnv["INPUT_WORKING_DIRECTORY"]?.trim() || ".",
  );
  const [command = "npx", ...prefix] = (
    actionEnv["INPUT_CLI"]?.trim() || "npx --no-install hot-updater"
  ).split(/\s+/);

  return (args, { capture = false } = {}) =>
    new Promise((resolve, reject) => {
      console.log(`$ hot-updater ${args.join(" ")}`);
      const child = spawn(command, [...prefix, ...args], {
        cwd,
        env,
        stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
      });
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      // Captured output goes to the log too, such as a build's.
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        process.stdout.write(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (capture) {
          resolve({ code: code ?? 1, stdout });
        } else if (code === 0) {
          resolve({ code, stdout });
        } else {
          reject(
            new Error(`hot-updater ${args.join(" ")} exited with ${code}.`),
          );
        }
      });
    });
};

/**
 * The JSON a `--json` command prints last: its whole output, or what
 * follows the lines a project's config or a build printed.
 *
 * @param {string} stdout
 * @returns {unknown}
 */
export const parseJsonOutput = (stdout) => {
  const lines = stdout.trimEnd().split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!/^[[{]/.test(lines[start] ?? "")) continue;
    try {
      return JSON.parse(lines.slice(start).join("\n"));
    } catch {
      // Inside the JSON, or a line of other output that looks like it.
    }
  }
  throw new Error(`Expected JSON output, got:\n${stdout}`);
};
