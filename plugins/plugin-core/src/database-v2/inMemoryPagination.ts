import type { DatabaseBackendScopeV2 } from "./backend";
import type { BundlePageV2 } from "./bundles";
import { cloneInMemoryVersionedBundleV2 } from "./inMemoryClone";
import {
  InMemoryCursorRegistryV2,
  throwInvalidInMemoryCursorV2,
} from "./inMemoryCursor";
import { bundleMatchesInMemoryWhereV2 } from "./inMemoryFilter";
import type {
  InMemoryPageRequestV2,
  InMemoryStoredBundleV2,
} from "./inMemoryTypes";

interface InMemoryPaginationInputV2 {
  readonly scope: DatabaseBackendScopeV2;
  readonly request: InMemoryPageRequestV2;
  readonly rows: readonly InMemoryStoredBundleV2[];
  readonly cursors: InMemoryCursorRegistryV2;
}

const sortedMatches = (
  rows: readonly InMemoryStoredBundleV2[],
  request: InMemoryPageRequestV2,
): readonly InMemoryStoredBundleV2[] => {
  const direction = request.query.direction === "asc" ? 1 : -1;
  return rows
    .filter((row) =>
      bundleMatchesInMemoryWhereV2(row.value, request.query.where),
    )
    .sort((left, right) =>
      left.value.id < right.value.id
        ? -direction
        : left.value.id > right.value.id
          ? direction
          : 0,
    );
};

const sliceBounds = (
  input: InMemoryPaginationInputV2,
  rows: readonly InMemoryStoredBundleV2[],
): readonly [number, number] => {
  if (input.request.cursor === null) {
    return [0, Math.min(input.request.query.limit, rows.length)];
  }
  const cursor = input.cursors.resolve({
    tenantId: input.scope.tenantId,
    principalId: input.scope.principalId,
    queryIdentity: input.request.identity,
    request: input.request.cursor,
  });
  const anchorIndex = rows.findIndex((row) => row.value.id === cursor.anchorId);
  if (anchorIndex < 0) {
    return throwInvalidInMemoryCursorV2();
  }
  switch (cursor.direction) {
    case "after": {
      const start = anchorIndex + 1;
      const end = Math.min(start + input.request.query.limit, rows.length);
      if (start === end) return throwInvalidInMemoryCursorV2();
      return [start, end];
    }
    case "before": {
      const end = anchorIndex;
      const start = Math.max(0, end - input.request.query.limit);
      if (start === end) return throwInvalidInMemoryCursorV2();
      return [start, end];
    }
  }
};

export const paginateInMemoryBundlesV2 = (
  input: InMemoryPaginationInputV2,
): BundlePageV2 => {
  const rows = sortedMatches(input.rows, input.request);
  const [start, end] = sliceBounds(input, rows);
  const data = rows.slice(start, end).map(cloneInMemoryVersionedBundleV2);
  const hasPreviousPage = start > 0;
  const hasNextPage = end < rows.length;
  const first = data[0];
  const last = data.at(-1);
  const cursorInput = {
    tenantId: input.scope.tenantId,
    principalId: input.scope.principalId,
    queryIdentity: input.request.identity,
  };
  return Object.freeze({
    data: Object.freeze(data),
    pagination: Object.freeze({
      total: rows.length,
      hasNextPage,
      hasPreviousPage,
      nextCursor:
        hasNextPage && last !== undefined
          ? input.cursors.create({
              ...cursorInput,
              direction: "after",
              anchorId: last.value.id,
            })
          : null,
      previousCursor:
        hasPreviousPage && first !== undefined
          ? input.cursors.create({
              ...cursorInput,
              direction: "before",
              anchorId: first.value.id,
            })
          : null,
    }),
  });
};
