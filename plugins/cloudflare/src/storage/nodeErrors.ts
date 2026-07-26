import { StoragePluginError } from "@hot-updater/plugin-core/storage";

const getStatusCode = (error: unknown): number | undefined => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("$metadata" in error) ||
    typeof error.$metadata !== "object" ||
    error.$metadata === null ||
    !("httpStatusCode" in error.$metadata) ||
    typeof error.$metadata.httpStatusCode !== "number"
  ) {
    return undefined;
  }
  return error.$metadata.httpStatusCode;
};

export const isR2NotFound = (error: unknown): boolean =>
  getStatusCode(error) === 404 ||
  (error instanceof Error &&
    (error.name === "NotFound" || error.name === "NoSuchKey"));

export const isR2Conflict = (error: unknown): boolean =>
  getStatusCode(error) === 412 ||
  (error instanceof Error && error.name === "PreconditionFailed");

export const mapR2Error = (error: unknown): StoragePluginError => {
  if (error instanceof StoragePluginError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new StoragePluginError(
      "aborted",
      "Cloudflare R2 operation was aborted.",
      { cause: error },
    );
  }
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "RequestTimeout")
  ) {
    return new StoragePluginError(
      "timeout",
      "Cloudflare R2 operation timed out.",
      { cause: error },
    );
  }
  const status = getStatusCode(error);
  const code =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 429
          ? "rate-limited"
          : "provider";
  return new StoragePluginError(
    code,
    "Cloudflare R2 provider operation failed.",
    { cause: error },
  );
};
