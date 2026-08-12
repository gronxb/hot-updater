import { DatabaseRowReferencedError } from "@hot-updater/plugin-core/internal";

const readErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
};

export const isChannelDeleteReferencedError = (error: unknown): boolean =>
  error instanceof DatabaseRowReferencedError ||
  [
    "23503",
    "SQLITE_CONSTRAINT_FOREIGNKEY",
    "SQLITE_CONSTRAINT",
    "ER_ROW_IS_REFERENCED",
    "ER_ROW_IS_REFERENCED_2",
    "P2003",
  ].includes(readErrorCode(error) ?? "");

export const translateChannelDeleteError = (error: unknown): never => {
  if (isChannelDeleteReferencedError(error)) {
    throw new DatabaseRowReferencedError();
  }
  throw error;
};
