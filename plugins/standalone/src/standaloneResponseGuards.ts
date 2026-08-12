import type {
  Bundle,
  ChannelRow,
  PaginatedResult,
} from "@hot-updater/plugin-core";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isChannelText = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0) return false;
  let codePoints = 0;
  for (const _codePoint of value) {
    codePoints += 1;
    if (codePoints > 255) return false;
  }
  return true;
};

const isChannelRow = (value: unknown): value is ChannelRow =>
  isRecord(value) && isChannelText(value.id) && isChannelText(value.name);

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
): value is { readonly data: { readonly channels: readonly ChannelRow[] } } =>
  isRecord(value) &&
  isRecord(value.data) &&
  Array.isArray(value.data.channels) &&
  value.data.channels.every(isChannelRow);

export const hasChannelInsertResult = (
  value: unknown,
): value is {
  readonly data: {
    readonly row: ChannelRow;
    readonly inserted: boolean;
  };
} =>
  isRecord(value) &&
  isRecord(value.data) &&
  isChannelRow(value.data.row) &&
  typeof value.data.inserted === "boolean";

export const hasChannelDeleteResult = (
  value: unknown,
): value is {
  readonly data:
    | { readonly deleted: true }
    | {
        readonly deleted: false;
        readonly reason: "not_empty" | "not_found";
      };
} =>
  isRecord(value) &&
  isRecord(value.data) &&
  (value.data.deleted === true ||
    (value.data.deleted === false &&
      (value.data.reason === "not_empty" ||
        value.data.reason === "not_found")));
