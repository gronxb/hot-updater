import { StoragePluginError } from "@hot-updater/plugin-core/storage";

const readProviderStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = Reflect.get(error, "code") ?? Reflect.get(error, "statusCode");
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    return Number(value);
  }
  return undefined;
};

export const isFirebaseStatus = (error: unknown, status: number): boolean =>
  readProviderStatus(error) === status;

export const mapFirebaseError = (error: unknown): StoragePluginError => {
  if (error instanceof StoragePluginError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new StoragePluginError(
      "aborted",
      "Firebase Storage operation was aborted.",
      { cause: error },
    );
  }

  const status = readProviderStatus(error);
  switch (status) {
    case 401:
      return new StoragePluginError(
        "unauthorized",
        "Firebase Storage authentication failed.",
        { cause: error },
      );
    case 403:
      return new StoragePluginError(
        "forbidden",
        "Firebase Storage access was forbidden.",
        { cause: error },
      );
    case 408:
    case 504:
      return new StoragePluginError(
        "timeout",
        "Firebase Storage operation timed out.",
        { cause: error },
      );
    case 429:
      return new StoragePluginError(
        "rate-limited",
        "Firebase Storage rate limit was exceeded.",
        { cause: error },
      );
    default:
      return new StoragePluginError(
        "provider",
        "Firebase Storage operation failed.",
        { cause: error },
      );
  }
};

export const firebaseNotFoundStatus = 404;
export const firebasePreconditionStatus = 412;
