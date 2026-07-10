import type { DatabasePluginCore } from "./databaseCoreTypes";
import {
  compareStrings,
  createOverlayPagination,
} from "./databaseRuntimeCursors";
import { bundleMatches, patchMatches } from "./databaseRuntimeFilters";
import {
  getCoreBundlePatchById,
  getPatchId,
  materializePatch,
} from "./databaseRuntimePatches";
import {
  applyBundlePatchUpdate,
  applyBundleUpdate,
  type RuntimeStageOverlayState,
} from "./databaseRuntimeStage";
import type {
  BundleListQuery,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
} from "./types";

export const overlayBundles = async (
  state: RuntimeStageOverlayState,
  core: DatabasePluginCore,
  page: CursorPage<DatabaseBundleRecord>,
  query: BundleListQuery,
): Promise<CursorPage<DatabaseBundleRecord>> => {
  const hasBundleMutations =
    state.bundleEntries.size > 0 || state.bundleUpdates.size > 0;
  const byId = new Map<string, DatabaseBundleRecord>();
  const baseById = new Map(page.data.map((bundle) => [bundle.id, bundle]));
  let total = page.pagination.total ?? page.data.length;

  for (const bundle of page.data) {
    const overlaidBundle = applyBundleUpdate(state.bundleUpdates, bundle);
    if (bundleMatches(overlaidBundle, query)) {
      byId.set(bundle.id, overlaidBundle);
    } else {
      byId.delete(bundle.id);
      total -= 1;
    }
  }

  for (const [bundleId, patch] of state.bundleUpdates) {
    if (baseById.has(bundleId) || state.bundleEntries.has(bundleId)) {
      continue;
    }
    const current = await core.bundles.getById({ bundleId });
    if (!current) {
      continue;
    }
    const overlaidBundle = { ...current, ...patch };
    const beforeMatches = bundleMatches(current, query);
    const afterMatches = bundleMatches(overlaidBundle, query);
    if (!beforeMatches && afterMatches) {
      total += 1;
    } else if (beforeMatches && !afterMatches) {
      total -= 1;
    }
    if (!beforeMatches && afterMatches) {
      byId.set(bundleId, overlaidBundle);
    }
  }

  for (const [bundleId, entry] of state.bundleEntries) {
    const baseBundle = baseById.get(bundleId);
    const beforeMatches = baseBundle
      ? bundleMatches(baseBundle, query)
      : await core.bundles
          .getById({ bundleId })
          .then((bundle) => (bundle ? bundleMatches(bundle, query) : false));
    if (entry.kind === "deleted") {
      byId.delete(bundleId);
      if (beforeMatches) {
        total -= 1;
      }
      continue;
    }
    if (bundleMatches(entry.bundle, query)) {
      byId.set(bundleId, entry.bundle);
      if (!beforeMatches) {
        total += 1;
      }
    } else {
      byId.delete(bundleId);
      if (beforeMatches) {
        total -= 1;
      }
    }
  }
  const direction = query.orderBy?.direction ?? "desc";
  const fullData = Array.from(byId.values()).sort((left, right) =>
    compareStrings(left.id, right.id, direction),
  );
  const data = fullData.slice(0, query.limit);
  return {
    ...page,
    data,
    pagination: createOverlayPagination(page, data, {
      limit: query.limit,
      total,
      fullDataLength: fullData.length,
      getCursor: (bundle) => bundle.id,
      preferPageCursors: !hasBundleMutations,
    }),
  };
};

export const overlayPatches = async (
  state: RuntimeStageOverlayState,
  core: DatabasePluginCore,
  page: CursorPage<DatabaseBundlePatch>,
  query: BundlePatchListQuery,
): Promise<CursorPage<DatabaseBundlePatch>> => {
  const hasPatchMutations =
    state.bundlePatchEntries.size > 0 || state.bundlePatchUpdates.size > 0;
  const byId = new Map<string, DatabaseBundlePatch>();
  const baseById = new Map(
    page.data.map((patch) => {
      const materializedPatch = materializePatch(patch);
      return [getPatchId(materializedPatch), materializedPatch];
    }),
  );
  let total = page.pagination.total ?? page.data.length;

  for (const patch of page.data) {
    const materializedPatch = materializePatch(patch);
    const overlaidPatch = applyBundlePatchUpdate(
      state.bundlePatchUpdates,
      materializedPatch,
    );
    if (patchMatches(overlaidPatch, query)) {
      byId.set(getPatchId(overlaidPatch), overlaidPatch);
    } else {
      total -= 1;
    }
  }

  for (const [patchId, patchUpdate] of state.bundlePatchUpdates) {
    if (baseById.has(patchId) || state.bundlePatchEntries.has(patchId)) {
      continue;
    }
    const current = await getCoreBundlePatchById(core.bundlePatches, patchId);
    if (!current) {
      continue;
    }
    const overlaidPatch = materializePatch({ ...current, ...patchUpdate });
    const beforeMatches = patchMatches(current, query);
    const afterMatches = patchMatches(overlaidPatch, query);
    if (!beforeMatches && afterMatches) {
      total += 1;
      byId.set(patchId, overlaidPatch);
    } else if (beforeMatches && !afterMatches) {
      total -= 1;
    }
  }

  for (const [patchId, entry] of state.bundlePatchEntries) {
    const basePatch =
      baseById.get(patchId) ??
      (await getCoreBundlePatchById(core.bundlePatches, patchId));
    const beforeMatches = basePatch ? patchMatches(basePatch, query) : false;
    if (entry.kind === "deleted") {
      byId.delete(patchId);
      if (beforeMatches) {
        total -= 1;
      }
      continue;
    }
    if (patchMatches(entry.patch, query)) {
      byId.set(patchId, entry.patch);
      if (!beforeMatches) {
        total += 1;
      }
    } else {
      byId.delete(patchId);
      if (beforeMatches) {
        total -= 1;
      }
    }
  }

  const data = Array.from(byId.values())
    .slice()
    .sort((left, right) => {
      const direction = query.orderBy?.direction ?? "asc";
      const field = query.orderBy?.field ?? "orderIndex";
      if (field === "orderIndex") {
        const result =
          left.orderIndex - right.orderIndex ||
          getPatchId(left).localeCompare(getPatchId(right));
        return direction === "asc" ? result : -result;
      }
      const leftValue = field === "id" ? getPatchId(left) : left[field];
      const rightValue = field === "id" ? getPatchId(right) : right[field];
      return compareStrings(leftValue, rightValue, direction);
    });
  const pageData = data.slice(0, query.limit);
  return {
    ...page,
    data: pageData,
    pagination: createOverlayPagination(page, pageData, {
      limit: query.limit,
      total,
      fullDataLength: data.length,
      getCursor: (patch) =>
        patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
      preferPageCursors: !hasPatchMutations,
    }),
  };
};
