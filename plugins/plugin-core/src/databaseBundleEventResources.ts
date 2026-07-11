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
  readonly deleteBeforeId?: (params: {
    readonly beforeId: string;
  }) => MaybePromise<void>;
}

const bundleEventResourceOverrides = new WeakMap<
  BundleEventStore,
  BundleEventResource
>();

export const setBundleEventResourceOverride = (
  store: BundleEventStore,
  resource: BundleEventResource,
): BundleEventStore => {
  bundleEventResourceOverrides.set(store, resource);
  return store;
};

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
  const resourceOverride = bundleEventResourceOverrides.get(store);
  if (resourceOverride) {
    return resourceOverride;
  }

  const resource: BundleEventResource = {
    async findMany(query) {
      const events = await store.findEvents();
      return listEvents(events, query);
    },
    async count({ where }) {
      const events = await store.findEvents();
      return events.filter((event) => eventMatchesWhere(event, where)).length;
    },
    async append(params) {
      await store.append(params);
    },
  };
  return store.deleteBeforeId
    ? {
        ...resource,
        async deleteBeforeId(params) {
          await store.deleteBeforeId?.(params);
        },
      }
    : resource;
};
