import {
  compareStrings,
  createOverlayPagination,
} from "./databaseRuntimeCursors";
import { eventMatches } from "./databaseRuntimeFilters";
import type { RuntimeStageOverlayState } from "./databaseRuntimeStage";
import type {
  BundleEventListQuery,
  CursorPage,
  DatabaseBundleEvent,
} from "./types";

export const overlayEvents = (
  state: RuntimeStageOverlayState,
  page: CursorPage<DatabaseBundleEvent>,
  query: BundleEventListQuery,
): CursorPage<DatabaseBundleEvent> => {
  const byId = new Map(page.data.map((event) => [event.id, event]));
  const baseEventIds = new Set(byId.keys());
  let total = page.pagination.total ?? page.data.length;
  for (const event of state.eventAppends) {
    if (eventMatches(event, query)) {
      byId.set(event.id, event);
      if (!baseEventIds.has(event.id)) {
        total += 1;
      }
    }
  }
  const direction = query.orderBy?.direction ?? "desc";
  const data = Array.from(byId.values()).sort((left, right) =>
    compareStrings(left.id, right.id, direction),
  );
  const pageData = data.slice(0, query.limit);
  return {
    ...page,
    data: pageData,
    pagination: createOverlayPagination(page, pageData, {
      limit: query.limit,
      total,
      fullDataLength: data.length,
      getCursor: (event) => event.id,
      preferPageCursors: state.eventAppends.length === 0,
    }),
  };
};
