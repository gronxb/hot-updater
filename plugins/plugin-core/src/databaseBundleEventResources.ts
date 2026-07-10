import {
  createOneShotReadSnapshot,
  shouldRememberReadSnapshot,
} from "./databaseReadSnapshot";
import { eventMatches } from "./databaseRuntimeFilters";
import type {
  BundleEventFindManyQuery,
  BundleEventListQuery,
  BundleEventResource,
  DatabaseBundleEvent,
  MaybePromise,
} from "./types";

export interface BundleEventStore {
  readonly findEvents: () => MaybePromise<readonly DatabaseBundleEvent[]>;
  readonly append: (params: {
    readonly event: DatabaseBundleEvent;
  }) => MaybePromise<void>;
}

const listEvents = (
  events: readonly DatabaseBundleEvent[],
  query: BundleEventFindManyQuery,
): readonly DatabaseBundleEvent[] => {
  const direction = query.orderBy?.direction ?? "desc";
  return events
    .filter((event) => eventMatchesWhere(event, query.where))
    .sort((left, right) => {
      const result = left.id.localeCompare(right.id);
      return direction === "asc" ? result : -result;
    })
    .slice(query.window.offset, query.window.offset + query.window.limit);
};

const eventMatchesWhere = (
  event: DatabaseBundleEvent,
  where: BundleEventListQuery["where"],
): boolean => eventMatches(event, { where, limit: Number.MAX_SAFE_INTEGER });

export const createBundleEventResource = (
  store: BundleEventStore,
): BundleEventResource => {
  const eventsSnapshot = createOneShotReadSnapshot<DatabaseBundleEvent>();

  const findEvents = async () => {
    return eventsSnapshot.take() ?? (await store.findEvents());
  };

  return {
    async findMany(query) {
      const events = await store.findEvents();
      const data = listEvents(events, query);
      if (shouldRememberReadSnapshot(data, query.window)) {
        eventsSnapshot.remember(events);
      }
      return data;
    },
    async count({ where }) {
      const events = await findEvents();
      return events.filter((event) => eventMatchesWhere(event, where)).length;
    },
    async append(params) {
      eventsSnapshot.clear();
      await store.append(params);
    },
  };
};
