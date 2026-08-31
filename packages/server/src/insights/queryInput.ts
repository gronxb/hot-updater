import type {
  ActiveInstallationInput,
  BundleEventInsightsWindow,
} from "./domain";
import { InsightsBadRequestError } from "./errors";

type IntegerBounds = {
  readonly defaultValue: number;
  readonly minimum: number;
  readonly maximum?: number;
};

const EVENT_LIST_BOUNDS = {
  defaultValue: 50,
  maximum: 100,
  minimum: 1,
} as const satisfies IntegerBounds;
const EVENT_LIST_OFFSET_BOUNDS = {
  defaultValue: 0,
  minimum: 0,
} as const satisfies IntegerBounds;
const MAX_USER_ID_LENGTH = 1_024;

export type PaginationInput = {
  readonly limit: number;
  readonly offset: number;
};

export type InsightsQueryInput = PaginationInput & {
  readonly window: BundleEventInsightsWindow;
};

function parseInteger(url: URL, key: string, bounds: IntegerBounds): number {
  const value = url.searchParams.get(key);
  if (value === null) return bounds.defaultValue;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < bounds.minimum ||
    (bounds.maximum !== undefined && parsed > bounds.maximum)
  ) {
    throw new InsightsBadRequestError(`Invalid '${key}' query parameter.`);
  }
  return parsed;
}

export const parsePagination = (request: Request): PaginationInput => {
  const url = new URL(request.url);
  return {
    limit: parseInteger(url, "limit", EVENT_LIST_BOUNDS),
    offset: parseInteger(url, "offset", EVENT_LIST_OFFSET_BOUNDS),
  };
};

export const parseInsightsQuery = (request: Request): InsightsQueryInput => {
  const url = new URL(request.url);
  const window = url.searchParams.get("window") ?? "24h";
  if (
    window !== "24h" &&
    window !== "7d" &&
    window !== "30d" &&
    window !== "all"
  ) {
    throw new InsightsBadRequestError("Invalid 'window' query parameter.");
  }
  return { ...parsePagination(request), window };
};

export const parseActiveInstallationInput = (
  request: Request,
): ActiveInstallationInput => {
  const url = new URL(request.url);
  const windows = url.searchParams.getAll("window");
  if (windows.length > 1) {
    throw new InsightsBadRequestError("Duplicate 'window' query parameter.");
  }
  const window = windows[0] ?? "30d";
  if (window !== "24h" && window !== "7d" && window !== "30d") {
    throw new InsightsBadRequestError("Invalid 'window' query parameter.");
  }
  const userIds = url.searchParams.getAll("userId");
  if (userIds.length > 1) {
    throw new InsightsBadRequestError("Duplicate 'userId' query parameter.");
  }
  const userId = userIds[0];
  if (
    userId !== undefined &&
    (userId.length === 0 || userId.length > MAX_USER_ID_LENGTH)
  ) {
    throw new InsightsBadRequestError("Invalid 'userId' query parameter.");
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
