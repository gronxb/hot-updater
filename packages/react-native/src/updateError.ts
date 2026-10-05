import type {
  UpdateError,
  UpdateErrorReason,
  UpdateErrorResource,
  UpdateErrorStage,
  UpdateErrorTransport,
} from "./clientPlugin";
import { HotUpdaterError } from "./error";

/**
 * A response the SDK cannot use: a malformed or stale catalog, an artifact
 * in another protocol, or an invalid URL.
 */
export class InvalidUpdateResponseError extends HotUpdaterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "InvalidUpdateResponseError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A request the server answered with a status the SDK does not accept. */
export class UpdateHttpError extends HotUpdaterError {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(
      `Request failed with HTTP ${status}${statusText ? ` ${statusText}` : ""}`,
    );
    this.name = "UpdateHttpError";
  }
}

const STAGES: readonly UpdateErrorStage[] = ["check", "download", "install"];
const REASONS: readonly UpdateErrorReason[] = [
  "network",
  "http",
  "invalid_response",
  "hash_mismatch",
  "signature",
  "patch",
  "extract",
  "storage",
  "unknown",
];
const RESOURCES: readonly UpdateErrorResource[] = [
  "catalog",
  "artifact",
  "manifest",
  "file",
  "patch",
  "archive",
];
const TRANSPORTS: readonly UpdateErrorTransport[] = [
  "timeout",
  "dns",
  "tls",
  "connection",
  "offline",
  "cancelled",
];
/** An S3, R2, or GCS error code: letters, digits, and punctuation only. */
const ORIGIN_CODE = /^[A-Za-z0-9._-]{1,64}$/;
/** Expo's iOS and Android names for a fetch canceled before its response. */
const EXPO_FETCH_CANCELED =
  /FetchRequestCanceledException|Fetch request has been canceled|The operation was aborted/;

type Classification = Pick<
  UpdateError,
  "stage" | "reason" | "resource" | "httpStatus" | "originCode" | "transport"
>;

const oneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => values.includes(value as T);

const readNativeClassification = (
  error: object,
): Classification | null | undefined => {
  if (!("code" in error) || typeof error.code !== "string") return undefined;
  const userInfo =
    "userInfo" in error && typeof error.userInfo === "object"
      ? (error.userInfo as Record<string, unknown> | null)
      : null;
  const { stage, reason, resource, transport, originCode } = userInfo ?? {};
  // Native classifies every failure of its download and install; a rejection
  // without it, such as a stale selection, is not an update failure.
  if (!oneOf(STAGES, stage) || !oneOf(REASONS, reason)) return null;
  const httpStatus = Number(userInfo?.httpStatus);
  return {
    stage,
    reason,
    ...(oneOf(RESOURCES, resource) ? { resource } : {}),
    ...(reason === "http" && Number.isSafeInteger(httpStatus)
      ? { httpStatus }
      : {}),
    ...(reason === "http" &&
    typeof originCode === "string" &&
    ORIGIN_CODE.test(originCode)
      ? { originCode }
      : {}),
    ...(reason === "network" && oneOf(TRANSPORTS, transport)
      ? { transport }
      : {}),
  };
};

/**
 * Where and why an update failed, or null when the error is not an update
 * failure. Native rejections carry their own classification; an error the
 * SDK's JavaScript raised happened in `stage`, fetching `resource` when one
 * is given.
 */
export const classifyUpdateError = (
  error: unknown,
  stage: UpdateErrorStage,
  resource?: UpdateErrorResource,
): Classification | null => {
  if (typeof error === "object" && error !== null) {
    const native = readNativeClassification(error);
    if (native !== undefined) return native;
  }
  const scope = {
    stage,
    ...(resource === undefined ? {} : { resource }),
  };
  // Names, not classes, so an error from another copy of a module still
  // classifies, as it does across test module resets.
  const name = error instanceof Error ? error.name : null;
  // A selection that became stale is a race between checks, not a failure.
  if (name === "StaleReleaseCatalogError") return null;
  if (name === "UpdateHttpError") {
    return {
      ...scope,
      reason: "http",
      httpStatus: (error as UpdateHttpError).status,
    };
  }
  if (name === "InvalidUpdateResponseError" || name === "SyntaxError") {
    return { ...scope, reason: "invalid_response" };
  }
  if (error instanceof Error && error.message === "Request timed out") {
    return { ...scope, reason: "network", transport: "timeout" };
  }
  if (name === "AbortError") {
    return { ...scope, reason: "network", transport: "cancelled" };
  }
  // Expo's fetch rejects with "fetch failed: <native exception>" when no
  // response arrives, and names a canceled request.
  if (error instanceof Error && error.message.startsWith("fetch failed:")) {
    return {
      ...scope,
      reason: "network",
      ...(EXPO_FETCH_CANCELED.test(error.message)
        ? { transport: "cancelled" }
        : {}),
    };
  }
  if (name === "TypeError") {
    // fetch rejects with a TypeError when no response arrives, without
    // saying why.
    return { ...scope, reason: "network" };
  }
  return { ...scope, reason: "unknown" };
};
