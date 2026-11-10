import { p } from "@hot-updater/cli-tools";

/**
 * An error no command expected: its message as people read an error, and
 * its stack and its properties, such as a response's body, with `DEBUG` set.
 */
export const reportUnexpectedError = (error: unknown): void => {
  p.log.error(error instanceof Error ? error.message : String(error));
  if (process.env["DEBUG"]) console.error(error);
};
