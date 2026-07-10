import {
  createOneShotReadSnapshot,
  shouldRememberReadSnapshot,
} from "./databaseReadSnapshot";
import { bundleMatchesQueryWhere } from "./queryBundles";
import type {
  BundleFindManyQuery,
  BundleResource,
  DatabaseBundleRecord,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  MaybePromise,
} from "./types";

export interface BundleStore {
  readonly getById: (params: {
    readonly bundleId: string;
  }) => MaybePromise<DatabaseBundleRecord | null>;
  readonly findRecords: () => MaybePromise<readonly DatabaseBundleRecord[]>;
  readonly insert: (params: {
    readonly bundle: DatabaseBundleRecord;
  }) => MaybePromise<void>;
  readonly update: (params: {
    readonly bundleId: string;
    readonly patch: Partial<DatabaseBundleRecord>;
  }) => MaybePromise<void>;
  readonly delete: (params: {
    readonly bundleId: string;
  }) => MaybePromise<void>;
}

const sortRecords = (
  records: readonly DatabaseBundleRecord[],
  orderBy?: DatabaseBundleQueryOrder,
): DatabaseBundleRecord[] => {
  const direction = orderBy?.direction ?? "desc";
  return [...records].sort((left, right) => {
    const result = left.id.localeCompare(right.id);
    return direction === "asc" ? result : -result;
  });
};

const listRecords = (
  records: readonly DatabaseBundleRecord[],
  query: BundleFindManyQuery,
): readonly DatabaseBundleRecord[] =>
  sortRecords(
    records.filter((record) => bundleMatchesQueryWhere(record, query.where)),
    query.orderBy,
  ).slice(query.window.offset, query.window.offset + query.window.limit);

type BundleStoreReadHint = (params: {
  readonly where?: DatabaseBundleQueryWhere;
}) => MaybePromise<readonly DatabaseBundleRecord[]>;

const bundleStoreReadHints = new WeakMap<BundleStore, BundleStoreReadHint>();
const bundleResourceOverrides = new WeakMap<BundleStore, BundleResource>();

export const setBundleStoreReadHint = (
  store: BundleStore,
  hint: BundleStoreReadHint,
): BundleStore => {
  bundleStoreReadHints.set(store, hint);
  return store;
};

export const setBundleResourceOverride = (
  store: BundleStore,
  resource: BundleResource,
): BundleStore => {
  bundleResourceOverrides.set(store, resource);
  return store;
};

export const createBundleResource = (store: BundleStore): BundleResource => {
  const resourceOverride = bundleResourceOverrides.get(store);
  if (resourceOverride) {
    return resourceOverride;
  }

  const recordsSnapshot = createOneShotReadSnapshot<DatabaseBundleRecord>();

  const findRecords = async (where?: DatabaseBundleQueryWhere) => {
    const snapshot = recordsSnapshot.take();
    if (snapshot) {
      return snapshot;
    }
    const hintedRead = bundleStoreReadHints.get(store);
    return hintedRead ? await hintedRead({ where }) : await store.findRecords();
  };

  return {
    getById: (params) => Promise.resolve(store.getById(params)),
    async findMany(query) {
      const records = await findRecords(query.where);
      const data = listRecords(records, query);
      if (shouldRememberReadSnapshot(data, query.window)) {
        recordsSnapshot.remember(records);
      }
      return data;
    },
    async count({ where }) {
      const records = await findRecords(where);
      return records.filter((record) => bundleMatchesQueryWhere(record, where))
        .length;
    },
    async insert(params) {
      recordsSnapshot.clear();
      await store.insert(params);
    },
    async update(params) {
      recordsSnapshot.clear();
      await store.update(params);
    },
    async delete(params) {
      recordsSnapshot.clear();
      await store.delete(params);
    },
  };
};
