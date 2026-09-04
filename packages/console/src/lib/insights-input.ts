import type { ActiveInstallationWindow } from "@hot-updater/server";
import type { BundleEventInsightsWindow } from "@hot-updater/server";

const MAX_INSIGHTS_STRING_LENGTH = 1024;
const MAX_INSIGHTS_LIMIT = 100;

export type BundleEventSummaryInput = {
  readonly bundleId: string;
};

export type BundleEventInsightsInput = BundleEventSummaryInput & {
  readonly window: BundleEventInsightsWindow;
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

export type ActiveInstallationInput = {
  readonly window: ActiveInstallationWindow;
  readonly userId?: string;
};

type InsightsPagination = {
  readonly limit?: number;
  readonly offset?: number;
};

export class InsightsInputValidationError extends Error {
  readonly name = "InsightsInputValidationError";

  constructor(readonly field: string) {
    super(`Invalid insights input: ${field}`);
  }
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const parseRecord = (input: unknown): Record<string, unknown> => {
  if (!isRecord(input)) {
    throw new InsightsInputValidationError("input");
  }
  return input;
};

const parseString = (input: Record<string, unknown>, field: string): string => {
  const value = input[field];
  if (typeof value !== "string") {
    throw new InsightsInputValidationError(field);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INSIGHTS_STRING_LENGTH) {
    throw new InsightsInputValidationError(field);
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
    value > MAX_INSIGHTS_LIMIT
  ) {
    throw new InsightsInputValidationError("limit");
  }
  return value;
};

const parseOffset = (input: Record<string, unknown>): number | undefined => {
  const value = input.offset;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InsightsInputValidationError("offset");
  }
  return value;
};

const parsePagination = (
  input: Record<string, unknown>,
): InsightsPagination => {
  const limit = parseLimit(input);
  const offset = parseOffset(input);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
};

const parseWindow = (
  input: Record<string, unknown>,
): BundleEventInsightsWindow => {
  const value = input.window;
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }
  throw new InsightsInputValidationError("window");
};

const parseActiveWindow = (
  input: Record<string, unknown>,
): ActiveInstallationWindow => {
  const value = input.window;
  if (value === "24h" || value === "7d" || value === "30d") {
    return value;
  }
  throw new InsightsInputValidationError("window");
};

const parseOptionalUserId = (
  input: Record<string, unknown>,
): string | undefined => {
  if (input.userId === undefined) return undefined;
  if (typeof input.userId !== "string") {
    throw new InsightsInputValidationError("userId");
  }
  const userId = input.userId.trim();
  if (userId.length === 0) return undefined;
  if (userId.length > MAX_INSIGHTS_STRING_LENGTH) {
    throw new InsightsInputValidationError("userId");
  }
  return userId;
};

export const parseActiveInstallationInput = (
  input: unknown,
): ActiveInstallationInput => {
  const record = parseRecord(input);
  const window = parseActiveWindow(record);
  const userId = parseOptionalUserId(record);
  return userId === undefined ? { window } : { window, userId };
};

export const parseBundleEventSummaryInput = (
  input: unknown,
): BundleEventSummaryInput => {
  const record = parseRecord(input);
  return { bundleId: parseString(record, "bundleId") };
};

export const parseBundleEventInsightsInput = (
  input: unknown,
): BundleEventInsightsInput => {
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

export const parseEventHistoryInput = (input: unknown): InsightsPagination =>
  parsePagination(parseRecord(input));
