import type { Bundle, PaginatedResult } from "@hot-updater/plugin-core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export const isBundle = (value: unknown): value is Bundle =>
  isRecord(value) &&
  typeof value.id === "string" &&
  (value.platform === "ios" || value.platform === "android") &&
  typeof value.enabled === "boolean" &&
  typeof value.shouldForceUpdate === "boolean" &&
  typeof value.fileHash === "string" &&
  typeof value.channel === "string" &&
  typeof value.storageUri === "string";

const isPaginationInfo = (
  value: unknown,
): value is PaginatedResult["pagination"] =>
  isRecord(value) &&
  isNonNegativeInteger(value.total) &&
  typeof value.hasNextPage === "boolean" &&
  typeof value.hasPreviousPage === "boolean" &&
  isNonNegativeInteger(value.currentPage) &&
  value.currentPage >= 1 &&
  isNonNegativeInteger(value.totalPages);

export const isPaginatedResult = (value: unknown): value is PaginatedResult =>
  isRecord(value) &&
  Array.isArray(value.data) &&
  value.data.every(isBundle) &&
  isPaginationInfo(value.pagination);

export const hasChannels = (
  value: unknown,
): value is { readonly data: { readonly channels: readonly string[] } } =>
  isRecord(value) &&
  isRecord(value.data) &&
  Array.isArray(value.data.channels) &&
  value.data.channels.every((channel) => typeof channel === "string");
