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
