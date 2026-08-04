import type { Bundle, GetBundlesArgs } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { rowsToBundles } from "@hot-updater/plugin-core";
import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";
import type { DocumentData, QuerySnapshot } from "firebase-admin/firestore";

import {
  parseFirebaseBundleRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseCollections } from "./firebaseDatabasePersistence";

const FIRESTORE_IN_LIMIT = 30;

const chunks = <T>(values: readonly T[]): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += FIRESTORE_IN_LIMIT) {
    result.push(values.slice(index, index + FIRESTORE_IN_LIMIT));
  }
  return result;
};

const parseBundles = (snapshot: QuerySnapshot<DocumentData>): BundleRow[] =>
  snapshot.docs.map((document) =>
    parseFirebaseBundleRow(document.data(), `bundles/${document.id}`),
  );

const parsePatches = (
  snapshot: QuerySnapshot<DocumentData>,
): BundlePatchRow[] =>
  snapshot.docs.map((document) =>
    parseFirebasePatchRow(document.data(), `bundle_patches/${document.id}`),
  );

export const loadFirebaseUpdateBundles = async (
  collections: FirebaseDatabaseCollections,
  args: GetBundlesArgs,
): Promise<Bundle[]> =>
  collections.bundles.firestore.runTransaction(
    async (transaction) => {
      const channel = args.channel ?? "production";
      const minBundleId = args.minBundleId ?? NIL_UUID;
      let query = collections.bundles
        .where("channel", "==", channel)
        .where("enabled", "==", true)
        .where("platform", "==", args.platform)
        .where("id", ">=", minBundleId);
      if (args._updateStrategy === "fingerprint") {
        query = query.where("fingerprint_hash", "==", args.fingerprintHash);
      }
      const owners = parseBundles(await transaction.get(query));
      if (owners.length === 0) return [];

      const ownerIds = owners.map(({ id }) => id);
      const patchSnapshots = await Promise.all(
        chunks(ownerIds).map((ids) =>
          transaction.get(
            collections.bundlePatches.where("bundle_id", "in", ids),
          ),
        ),
      );
      const patches = patchSnapshots.flatMap(parsePatches);
      const ownerIdSet = new Set(ownerIds);
      const baseIds = [
        ...new Set(
          patches
            .map(({ base_bundle_id }) => base_bundle_id)
            .filter((id) => !ownerIdSet.has(id)),
        ),
      ];
      const baseSnapshots = await Promise.all(
        chunks(baseIds).map((ids) =>
          transaction.get(collections.bundles.where("id", "in", ids)),
        ),
      );
      const bases = baseSnapshots.flatMap(parseBundles);
      return rowsToBundles(owners, patches, bases);
    },
    { readOnly: true },
  );
