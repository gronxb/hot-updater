import { p } from "@hot-updater/cli-tools";

/**
 * Whether the command can ask `message`. Without a terminal to answer in, it
 * logs the question with how to re-run without it, such as `Re-run with -y`,
 * sets exit code 1, and returns false, rather than wait on a prompt that
 * nobody can answer.
 */
export const canPrompt = (
  message: string,
  rerun = "Re-run with -y",
): boolean => {
  if (process.stdin.isTTY) return true;
  p.log.error(`${message} ${rerun} in a non-interactive shell.`);
  process.exitCode = 1;
  return false;
};
