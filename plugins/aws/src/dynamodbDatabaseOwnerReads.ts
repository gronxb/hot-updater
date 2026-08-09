import type { BundlePatchRow } from "@hot-updater/plugin-core";

import {
  loadBundleItemsById,
  loadPatchItemsById,
} from "./dynamodbDatabaseKeyReads";
import {
  loadBundleItem,
  queryOwnerPatchIds,
  type DynamoDBStore,
} from "./dynamodbDatabaseStore";

export class DynamoDBPatchIndexConsistencyError extends Error {
  readonly name = "DynamoDBPatchIndexConsistencyError";

  constructor(
    readonly bundleId: string,
    readonly expectedCount: number,
  ) {
    super(
      `DynamoDB patch index did not converge to ${expectedCount} rows for bundle "${bundleId}"`,
    );
  }
}

const waitForIndex = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));

export const queryCompleteOwnerPatches = async (
  store: DynamoDBStore,
  indexName: string,
  bundleId: string,
): Promise<BundlePatchRow[]> => {
  const owner = await loadBundleItem(store, bundleId);
  if (!owner || owner.owned_patch_count === 0) return [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const patchIds = await queryOwnerPatchIds(store, indexName, bundleId);
    const patchIdSet = new Set(patchIds);
    const patches = (await loadPatchItemsById(store, patchIds)).filter(
      ({ row }) => row.bundle_id === bundleId,
    );
    if (
      patchIds.length === owner.owned_patch_count &&
      patchIdSet.size === owner.owned_patch_count &&
      patches.length === owner.owned_patch_count &&
      patches.every(({ sk }) => patchIdSet.has(sk))
    ) {
      return patches
        .map(({ row }) => row)
        .sort(
          (left, right) =>
            left.order_index - right.order_index ||
            left.id.localeCompare(right.id),
        );
    }
    if (attempt < 2) await waitForIndex(attempt);
  }
  throw new DynamoDBPatchIndexConsistencyError(
    bundleId,
    owner.owned_patch_count,
  );
};

export const queryCompleteOwnersPatches = async (
  store: DynamoDBStore,
  indexName: string,
  bundleIds: readonly string[],
): Promise<BundlePatchRow[]> => {
  const owners = (await loadBundleItemsById(store, bundleIds)).filter(
    ({ owned_patch_count }) => owned_patch_count > 0,
  );
  const firstOwner = owners[0];
  if (!firstOwner) return [];
  let failedOwner = firstOwner;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidateIdsByOwner = await Promise.all(
      owners.map(({ sk }) => queryOwnerPatchIds(store, indexName, sk)),
    );
    const candidateIds = candidateIdsByOwner.flat();
    const patches = await loadPatchItemsById(store, candidateIds);
    const patchesById = new Map(patches.map((patch) => [patch.sk, patch]));
    const mismatchedOwner = owners.find((owner, ownerIndex) => {
      const ids = candidateIdsByOwner[ownerIndex] ?? [];
      const uniqueIds = new Set(ids);
      return (
        ids.length !== owner.owned_patch_count ||
        uniqueIds.size !== owner.owned_patch_count ||
        ids.some((id) => patchesById.get(id)?.row.bundle_id !== owner.sk)
      );
    });
    if (!mismatchedOwner) return patches.map(({ row }) => row);
    failedOwner = mismatchedOwner;
    if (attempt < 2) await waitForIndex(attempt);
  }
  throw new DynamoDBPatchIndexConsistencyError(
    failedOwner.sk,
    failedOwner.owned_patch_count,
  );
};
