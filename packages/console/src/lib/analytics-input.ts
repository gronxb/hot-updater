import type { BundleEventAnalyticsWindow } from "@hot-updater/server/db";

const MAX_ANALYTICS_STRING_LENGTH = 1024;
const MAX_ANALYTICS_LIMIT = 100;

export type BundleEventSummaryInput = {
  readonly bundleId: string;
};

export type BundleEventAnalyticsInput = BundleEventSummaryInput & {
  readonly window: BundleEventAnalyticsWindow;
  readonly limit?: number;
  readonly offset?: number;
};

export type SearchInstallationsInput = {
  readonly query: string;
  readonly limit?: number;
  readonly offset?: number;
};

export type InstallationHistoryInput = {
  readonly installId: string;
  readonly limit?: number;
  readonly offset?: number;
};

type AnalyticsPagination = {
  readonly limit?: number;
  readonly offset?: number;
};

export class AnalyticsInputValidationError extends Error {
  readonly name = "AnalyticsInputValidationError";

  constructor(readonly field: string) {
    super(`Invalid analytics input: ${field}`);
  }
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const parseRecord = (input: unknown): Record<string, unknown> => {
  if (!isRecord(input)) {
    throw new AnalyticsInputValidationError("input");
  }
  return input;
};

const parseString = (input: Record<string, unknown>, field: string): string => {
  const value = input[field];
  if (typeof value !== "string") {
    throw new AnalyticsInputValidationError(field);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ANALYTICS_STRING_LENGTH) {
    throw new AnalyticsInputValidationError(field);
  }
  return trimmed;
};

const parseLimit = (input: Record<string, unknown>): number | undefined => {
  const value = input.limit;
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_ANALYTICS_LIMIT
  ) {
    throw new AnalyticsInputValidationError("limit");
  }
  return value;
};

const parseOffset = (input: Record<string, unknown>): number | undefined => {
  const value = input.offset;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AnalyticsInputValidationError("offset");
  }
  return value;
};

const parsePagination = (
  input: Record<string, unknown>,
): AnalyticsPagination => {
  const limit = parseLimit(input);
  const offset = parseOffset(input);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
};

const parseWindow = (
  input: Record<string, unknown>,
): BundleEventAnalyticsWindow => {
  const value = input.window;
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }
  throw new AnalyticsInputValidationError("window");
};

export const parseBundleEventSummaryInput = (
  input: unknown,
): BundleEventSummaryInput => {
  const record = parseRecord(input);
  return { bundleId: parseString(record, "bundleId") };
};

export const parseBundleEventAnalyticsInput = (
  input: unknown,
): BundleEventAnalyticsInput => {
  const record = parseRecord(input);
  return {
    bundleId: parseString(record, "bundleId"),
    window: parseWindow(record),
    ...parsePagination(record),
  };
};

export const parseSearchInstallationsInput = (
  input: unknown,
): SearchInstallationsInput => {
  const record = parseRecord(input);
  return {
    query: parseString(record, "query"),
    ...parsePagination(record),
  };
};

export const parseInstallationHistoryInput = (
  input: unknown,
): InstallationHistoryInput => {
  const record = parseRecord(input);
  return {
    installId: parseString(record, "installId"),
    ...parsePagination(record),
  };
};
