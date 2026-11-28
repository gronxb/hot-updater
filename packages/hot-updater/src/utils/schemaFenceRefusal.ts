import { p } from "@hot-updater/cli-tools";

import { exitWhenFlushed } from "./exitWhenFlushed";

/**
 * Whether a command stopped at the schema fence. Matched by name: the
 * config's database adapter may load another copy of plugin-core.
 */
export const isSchemaFenceRefusal = (error: unknown): error is Error =>
  error instanceof Error &&
  error.name === "HotUpdaterSchemaMigrationRequiredError";

/**
 * Ends a command that stopped at the schema fence: its message says what to
 * do, so it is printed as one line, without a stack, on stderr as Node's
 * report was, so `--json` output stays clean, and the CLI exits 1. Any other
 * error is thrown on unchanged and keeps Node's report.
 */
export const endAtSchemaFence = (error: unknown): Promise<never> => {
  if (!isSchemaFenceRefusal(error)) throw error;
  p.log.error(error.message, { output: process.stderr });
  return exitWhenFlushed(1);
};
