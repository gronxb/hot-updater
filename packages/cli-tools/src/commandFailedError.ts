import path from "node:path";
import { stripVTControlCharacters } from "node:util";

/** The output lines a failure keeps without an error line: its last ones. */
const OUTPUT_TAIL_LINES = 8;
/** The lines a failure keeps from the error line on, such as Metro's. */
const ERROR_LINES = 12;

/**
 * The error a build adapter throws when a command it runs, such as
 * `expo export:embed`, fails: its exit code, or the signal that stopped it,
 * then its output, stdout and stderr together, without stack frames: from the
 * last line that starts with `error`, as Metro's and Expo's do, else its last
 * lines. A code above
 * 255 is a Windows NTSTATUS, such as 0xC0000005 for a crash, and prints in
 * hex too. With `rerun`, the command as people run it in the project, it ends
 * with that one next step. An error that isn't a command's is returned as
 * it is.
 */
export const commandFailedError = (
  command: string,
  error: unknown,
  rerun?: string,
): Error => {
  const { exitCode, signal, all, stdout, stderr } = (error ?? {}) as {
    exitCode?: unknown;
    signal?: unknown;
    all?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  if (typeof exitCode !== "number" && typeof signal !== "string") {
    return error instanceof Error ? error : new Error(String(error));
  }
  const reason =
    typeof signal === "string"
      ? `${command} was stopped by ${signal}.`
      : `${command} exited with code ${exitCode}${
          (exitCode as number) > 255
            ? ` (0x${(exitCode as number).toString(16).toUpperCase()})`
            : ""
        }.`;
  const output =
    typeof all === "string" && all
      ? all
      : [stdout, stderr].filter((text) => typeof text === "string").join("\n");
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*at /.test(line));
  const errorLine = lines.findLastIndex((line) => /^\s*error\b/i.test(line));
  const shown =
    errorLine === -1
      ? lines.slice(-OUTPUT_TAIL_LINES)
      : lines.slice(errorLine, errorLine + ERROR_LINES);
  const nextStep =
    rerun === undefined ? [] : ["Run it for its full output:", rerun];
  return new Error([reason, ...shown, ...nextStep].join("\n"), {
    cause: error,
  });
};

/**
 * `npx <args>` as a shell reads it, with paths under `cwd` relative to it:
 * the command a failure tells people to run.
 */
export const npxCommandLine = (cwd: string, args: readonly string[]): string =>
  [
    "npx",
    ...args.map((arg) => {
      const relative =
        path.isAbsolute(arg) && !path.relative(cwd, arg).startsWith("..")
          ? path.relative(cwd, arg) || "."
          : arg;
      // A Windows path's backslashes need no quotes in cmd or PowerShell.
      return /^[\w@%+=:,./\\-]+$/.test(relative)
        ? relative
        : `'${relative.replace(/'/g, "'\\''")}'`;
    }),
  ].join(" ");
