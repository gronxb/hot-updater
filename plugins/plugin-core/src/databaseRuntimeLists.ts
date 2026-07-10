import type { DatabasePluginCore } from "./databaseCoreTypes";
import {
  createCorePagination,
  emptyPage,
  queryWindow,
  resolveCoreTotal,
} from "./databaseRuntimeCursors";
import { materializePatch } from "./databaseRuntimePatches";
import type {
  BundleEventFindManyQuery,
  BundleEventListQuery,
  BundleEventResource,
  BundleFindManyQuery,
  BundleListQuery,
  BundlePatchFindManyQuery,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
} from "./types";

export const listCoreBundles = async (
  core: DatabasePluginCore,
  query: BundleListQuery,
): Promise<CursorPage<DatabaseBundleRecord>> => {
  const window = queryWindow(query);
  const findManyQuery: BundleFindManyQuery = {
    where: query.where,
    orderBy: query.orderBy,
    window,
  };
  const data = await core.bundles.findMany(findManyQuery);
  const total = await resolveCoreTotal(data, window, () =>
    core.bundles.count({ where: query.where }),
  );
  return {
    data,
    pagination: createCorePagination(data, {
      limit: window.limit,
      offset: window.offset,
      total,
    }),
  };
};

export const listCoreBundlePatches = async (
  core: DatabasePluginCore,
  query: BundlePatchListQuery,
): Promise<CursorPage<DatabaseBundlePatch>> => {
  const window = queryWindow(query);
  const findManyQuery: BundlePatchFindManyQuery = {
    where: query.where,
    orderBy: query.orderBy,
    window,
  };
  const data = (await core.bundlePatches.findMany(findManyQuery)).map(
    materializePatch,
  );
  const total = await resolveCoreTotal(data, window, () =>
    core.bundlePatches.count({ where: query.where }),
  );
  return {
    data,
    pagination: createCorePagination(data, {
      limit: window.limit,
      offset: window.offset,
      total,
    }),
  };
};

export const listCoreBundleEvents = async (
  resource: BundleEventResource | undefined,
  query: BundleEventListQuery,
): Promise<CursorPage<DatabaseBundleEvent>> => {
  if (!resource) {
    return emptyPage<DatabaseBundleEvent>();
  }
  const window = queryWindow(query);
  const findManyQuery: BundleEventFindManyQuery = {
    where: query.where,
    orderBy: query.orderBy,
    window,
  };
  const data = await resource.findMany(findManyQuery);
  const total = await resolveCoreTotal(data, window, () =>
    resource.count({ where: query.where }),
  );
  return {
    data,
    pagination: createCorePagination(data, {
      limit: window.limit,
      offset: window.offset,
      total,
    }),
  };
};
