import path from "node:path";
import { stripVTControlCharacters } from "node:util";

/** The output lines a failure keeps without an error line: its last ones. */
const OUTPUT_TAIL_LINES = 8;
/** The lines a failure keeps from the error line on, such as Metro's. */
const ERROR_LINES = 12;
/** A frame of a Ruby backtrace, such as Bundler's under its exception. */
const RUBY_FRAME = /^\s+from \S.*:\d+:in /;

/**
 * The error a build adapter throws when a command it runs, such as
 * `expo export:embed`, fails: its exit code, or the signal that stopped it,
 * then its output, stdout and stderr together, without Node's or Ruby's stack
 * frames: from the last line that starts with `error`, as Metro's and Expo's
 * do, else its last lines. A code above 255 is a Windows NTSTATUS, such as
 * 0xC0000005 for a crash, and prints in hex too. With `rerun`, the command as people run it in the project, it ends
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
    .filter(
      (line) => line.trim() && !/^\s*at /.test(line) && !RUBY_FRAME.test(line),
    );
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
 * `npx <args>` as this platform's shell reads it, with paths under `cwd`
 * relative to it: the command a failure tells people to run. On Windows an
 * argument that needs quotes takes double quotes, which cmd.exe and
 * PowerShell both read; elsewhere, POSIX single quotes.
 */
export const npxCommandLine = (
  cwd: string,
  args: readonly string[],
): string => {
  const windows = process.platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  return [
    "npx",
    ...args.map((arg) => {
      const relative =
        paths.isAbsolute(arg) && !paths.relative(cwd, arg).startsWith("..")
          ? paths.relative(cwd, arg) || "."
          : arg;
      // A Windows path's backslashes need no quotes in cmd or PowerShell.
      if (/^[\w@%+=:,./\\-]+$/.test(relative)) return relative;
      return windows
        ? `"${relative.replace(/"/g, '\\"')}"`
        : `'${relative.replace(/'/g, "'\\''")}'`;
    }),
  ].join(" ");
};
