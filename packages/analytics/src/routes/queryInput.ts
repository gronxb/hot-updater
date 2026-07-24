import type {
  ActiveInstallationInput,
  BundleEventAnalyticsWindow,
} from "../domain";
import { AnalyticsBadRequestError } from "./support";

const EVENT_LIST_BOUNDS = { defaultValue: 50, maxValue: 100 } as const;
const MAX_USER_ID_LENGTH = 1024;

export interface PaginationInput {
  readonly limit: number;
  readonly offset: number;
}

export interface AnalyticsQueryInput extends PaginationInput {
  readonly window: BundleEventAnalyticsWindow;
}

const parsePositiveInteger = (
  url: URL,
  key: string,
  defaultValue: number,
  maximum: number,
): number => {
  const value = url.searchParams.get(key);
  if (value === null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AnalyticsBadRequestError(
      `The '${key}' query parameter must be a positive integer between 1 and ${maximum}.`,
    );
  }
  return parsed;
};

const parseNonNegativeInteger = (
  url: URL,
  key: string,
  defaultValue: number,
): number => {
  const value = url.searchParams.get(key);
  if (value === null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AnalyticsBadRequestError(
      `The '${key}' query parameter must be a non-negative integer.`,
    );
  }
  return parsed;
};

export const parsePagination = (request: Request): PaginationInput => {
  const url = new URL(request.url);
  return {
    limit: parsePositiveInteger(
      url,
      "limit",
      EVENT_LIST_BOUNDS.defaultValue,
      EVENT_LIST_BOUNDS.maxValue,
    ),
    offset: parseNonNegativeInteger(url, "offset", 0),
  };
};

export const parseAnalyticsQuery = (request: Request): AnalyticsQueryInput => {
  const url = new URL(request.url);
  const window = url.searchParams.get("window") ?? "24h";
  if (
    window !== "24h" &&
    window !== "7d" &&
    window !== "30d" &&
    window !== "all"
  ) {
    throw new AnalyticsBadRequestError(
      "The 'window' query parameter must be one of '24h', '7d', '30d', or 'all'.",
    );
  }
  return { ...parsePagination(request), window };
};

export const parseActiveInstallationInput = (
  request: Request,
): ActiveInstallationInput => {
  const url = new URL(request.url);
  const windows = url.searchParams.getAll("window");
  if (windows.length > 1) {
    throw new AnalyticsBadRequestError(
      "The 'window' query parameter must be provided at most once.",
    );
  }
  const window = windows[0] ?? "30d";
  if (window !== "24h" && window !== "7d" && window !== "30d") {
    throw new AnalyticsBadRequestError(
      "The 'window' query parameter must be one of '24h', '7d', or '30d'.",
    );
  }
  const userIds = url.searchParams.getAll("userId");
  if (userIds.length > 1) {
    throw new AnalyticsBadRequestError(
      "The 'userId' query parameter must be provided at most once.",
    );
  }
  const userId = userIds[0];
  if (
    userId !== undefined &&
    (userId.length === 0 || userId.length > MAX_USER_ID_LENGTH)
  ) {
    throw new AnalyticsBadRequestError("Invalid 'userId' query parameter.");
  }
  return userId === undefined ? { window } : { window, userId };
};

export const parseSearchInput = (
  request: Request,
): PaginationInput & { readonly query: string } => ({
  ...parsePagination(request),
  query: new URL(request.url).searchParams.get("query")?.trim() ?? "",
});

export const parseEmptyInput = (): undefined => undefined;
