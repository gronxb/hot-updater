import { isPrintedTaskError, p } from "@hot-updater/cli-tools";

/**
 * An error no command expected: its message as people read an error, unless
 * the task it failed printed it already, and its stack and its properties,
 * such as a response's body or its cause, with `DEBUG` set.
 */
export const reportUnexpectedError = (error: unknown): void => {
  if (!isPrintedTaskError(error)) {
    p.log.error(error instanceof Error ? error.message : String(error));
  }
  if (process.env["DEBUG"]) console.error(error);
};
