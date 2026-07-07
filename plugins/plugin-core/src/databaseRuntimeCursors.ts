import type { CursorPage, DatabaseResourceWindow } from "./types";

const emptyPagination = {
  hasNextPage: false,
  hasPreviousPage: false,
  nextCursor: null,
  previousCursor: null,
} as const;

export const emptyPage = <TData>(): CursorPage<TData> => ({
  data: [],
  pagination: emptyPagination,
});

const offsetCursorPrefix = "offset:";

const encodeOffsetCursor = (offset: number): string =>
  `${offsetCursorPrefix}${Math.max(0, Math.trunc(offset))}`;

const decodeOffsetCursor = (cursor: string | undefined): number | null => {
  if (!cursor?.startsWith(offsetCursorPrefix)) {
    return null;
  }
  const offset = Number(cursor.slice(offsetCursorPrefix.length));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return null;
  }
  return offset;
};

export const compareStrings = (
  left: string,
  right: string,
  direction: "asc" | "desc",
) => {
  const result = left.localeCompare(right);
  return direction === "asc" ? result : -result;
};

export const queryWindow = (query: {
  readonly limit: number;
  readonly page?: number;
  readonly cursor?: {
    readonly after?: string;
    readonly before?: string;
  };
}) => {
  if ("offset" in query) {
    throw new Error(
      "Bundle offset pagination has been removed. Use cursor.after or cursor.before instead.",
    );
  }

  const limit = Math.max(0, query.limit);
  if (query.page !== undefined && query.page > 0) {
    return {
      offset: limit > 0 ? (Math.trunc(query.page) - 1) * limit : 0,
      limit,
    };
  }
  const afterOffset = decodeOffsetCursor(query.cursor?.after);
  if (afterOffset !== null) {
    return { offset: afterOffset + 1, limit };
  }
  const beforeOffset = decodeOffsetCursor(query.cursor?.before);
  if (beforeOffset !== null) {
    return { offset: Math.max(0, beforeOffset - limit), limit };
  }
  return { offset: 0, limit };
};

export const createCorePagination = <TData>(
  data: readonly TData[],
  options: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  },
): CursorPage<TData>["pagination"] => {
  const total = Math.max(0, options.total);
  const limit = Math.max(0, options.limit);
  const offset = Math.max(0, options.offset);
  const hasNextPage = limit > 0 && offset + data.length < total;
  const hasPreviousPage = limit > 0 && offset > 0;
  return {
    total,
    currentPage: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
    totalPages: limit > 0 && total > 0 ? Math.ceil(total / limit) : 0,
    hasNextPage,
    hasPreviousPage,
    nextCursor:
      hasNextPage && data.length > 0
        ? encodeOffsetCursor(offset + data.length - 1)
        : null,
    previousCursor: hasPreviousPage ? encodeOffsetCursor(offset) : null,
  };
};

export const resolveCoreTotal = async <TData>(
  data: readonly TData[],
  window: DatabaseResourceWindow,
  count: () => Promise<number>,
): Promise<number> => {
  if (
    window.limit > 0 &&
    data.length < window.limit &&
    (data.length > 0 || window.offset === 0)
  ) {
    return window.offset + data.length;
  }
  return count();
};

export const createOverlayPagination = <TData>(
  page: CursorPage<TData>,
  data: readonly TData[],
  options: {
    readonly limit: number;
    readonly total: number;
    readonly fullDataLength: number;
    readonly getCursor: (item: TData) => string | null | undefined;
    readonly preferPageCursors?: boolean;
  },
): CursorPage<TData>["pagination"] => {
  const total = Math.max(0, options.total);
  const nextCursor = data.at(-1) ? options.getCursor(data.at(-1)!) : null;
  const previousCursor = data[0] ? options.getCursor(data[0]) : null;
  const currentPage = Math.max(1, page.pagination.currentPage ?? 1);
  const startOffset = options.limit > 0 ? (currentPage - 1) * options.limit : 0;
  const hasNextPage = options.preferPageCursors
    ? page.pagination.hasNextPage || options.fullDataLength > options.limit
    : startOffset + data.length < total;
  const pageNextCursor = options.preferPageCursors
    ? page.pagination.nextCursor
    : null;
  const pagePreviousCursor = options.preferPageCursors
    ? page.pagination.previousCursor
    : null;
  return {
    ...page.pagination,
    total,
    totalPages:
      options.limit > 0 && total > 0 ? Math.ceil(total / options.limit) : 0,
    hasNextPage,
    hasPreviousPage: page.pagination.hasPreviousPage,
    nextCursor: hasNextPage ? (pageNextCursor ?? nextCursor ?? null) : null,
    previousCursor: page.pagination.hasPreviousPage
      ? (pagePreviousCursor ?? previousCursor ?? null)
      : null,
  };
};
