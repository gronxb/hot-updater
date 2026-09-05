import type {
  ActiveInstallationWindow,
  InsightsBundleSelection,
  InsightsScope,
} from "./domain";
import { InsightsBadRequestError } from "./errors";
import type {
  InsightsEventPageInput,
  InsightsUserInstallationPageInput,
} from "./types";

const MAX_PAGE_LIMIT = 100;
const MAX_IDENTITY_LENGTH = 255;
const MAX_CURSOR_LENGTH = 8 * 1_024;

const readSingle = (url: URL, key: string): string | undefined => {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) {
    throw new InsightsBadRequestError(`Duplicate '${key}' query parameter.`);
  }
  return values[0];
};

const readPageLimit = (url: URL): number | undefined => {
  const value = readSingle(url, "limit");
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new InsightsBadRequestError("Invalid 'limit' query parameter.");
  }
  return limit;
};

const readCursor = (url: URL): string | undefined => {
  const cursor = readSingle(url, "cursor");
  if (
    cursor !== undefined &&
    (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)
  ) {
    throw new InsightsBadRequestError("Invalid 'cursor' query parameter.");
  }
  return cursor;
};

const readId = (
  url: URL,
  key: string,
  maximumLength = MAX_IDENTITY_LENGTH,
): string => {
  const value = readSingle(url, key);
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new InsightsBadRequestError(`Invalid '${key}' query parameter.`);
  }
  return value;
};

const readTimestamp = (url: URL, key: string): number | undefined => {
  const raw = readSingle(url, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!raw.length || !Number.isSafeInteger(value) || value < 0) {
    throw new InsightsBadRequestError(`Invalid '${key}' query parameter.`);
  }
  return value;
};

const readScope = (url: URL): InsightsScope => {
  const platform = readSingle(url, "platform");
  if (platform !== "ios" && platform !== "android") {
    throw new InsightsBadRequestError("Invalid 'platform' query parameter.");
  }
  return { platform, channel: readId(url, "channel", 1_024) };
};

export const parseEventPageInput = (
  request: Request,
): InsightsEventPageInput => {
  const url = new URL(request.url);
  const bundleFields = ["bundleId", "outcome", "platform", "channel"];
  let bundle: InsightsBundleSelection | undefined;
  if (bundleFields.some((key) => url.searchParams.has(key))) {
    const outcome = readSingle(url, "outcome");
    if (
      outcome !== "applied" &&
      outcome !== "recovered" &&
      outcome !== "adopted"
    ) {
      throw new InsightsBadRequestError("Invalid 'outcome' query parameter.");
    }
    bundle = {
      ...readScope(url),
      bundleId: readId(url, "bundleId", 1_024),
      outcome,
    };
  }
  return {
    beforeReceivedAtMs: readTimestamp(url, "beforeReceivedAtMs"),
    sinceMs: readTimestamp(url, "sinceMs"),
    cursor: readCursor(url),
    limit: readPageLimit(url),
    ...(bundle === undefined ? {} : { bundle }),
  };
};

export const parseUserInstallationPageInput = (
  request: Request,
): InsightsUserInstallationPageInput => {
  const url = new URL(request.url);
  const cursor = readCursor(url);
  const limit = readPageLimit(url);
  return {
    userId: readId(url, "userId"),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
};

export const parseReportingOverviewInput = (
  request: Request,
): InsightsScope & {
  readonly window: ActiveInstallationWindow;
  readonly bundleId?: string;
} => {
  const url = new URL(request.url);
  const window = readSingle(url, "window") ?? "30d";
  if (window !== "24h" && window !== "7d" && window !== "30d") {
    throw new InsightsBadRequestError("Invalid 'window' query parameter.");
  }
  const bundleId = readSingle(url, "bundleId");
  return {
    ...readScope(url),
    window,
    ...(bundleId === undefined
      ? {}
      : { bundleId: readId(url, "bundleId", 1_024) }),
  };
};
