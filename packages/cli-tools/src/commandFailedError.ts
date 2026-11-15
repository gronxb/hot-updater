/** The output lines a failure keeps: enough for the cause, no more. */
const OUTPUT_TAIL_LINES = 8;

/**
 * The error a build adapter throws when a command it runs, such as
 * `expo export:embed`, fails: its exit code, or the signal that stopped it,
 * then the last lines of its output, stdout and stderr together. A code above
 * 255 is a Windows NTSTATUS, such as 0xC0000005 for a crash, and prints in
 * hex too. An error that isn't a command's is returned as it is.
 */
export const commandFailedError = (command: string, error: unknown): Error => {
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
  const tail = output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-OUTPUT_TAIL_LINES);
  return new Error([reason, ...tail].join("\n"), { cause: error });
};
