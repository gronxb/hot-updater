import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
  NIL_UUID,
  type SnakeCaseBundle,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type {
  Bundle,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundlePatch,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  DatabasePluginCore,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
  toBundleReadModel,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import admin from "firebase-admin";

type FirestoreData = admin.firestore.DocumentData;
type FirestoreBundleData = Omit<SnakeCaseBundle, "patches"> & {
  readonly patches?: Bundle["patches"] | null;
};

type BundleIndexReference = Pick<
  DatabaseBundleRecord,
  "channel" | "platform" | "targetAppVersion"
>;

const getTargetAppVersionDocId = (bundle: BundleIndexReference) =>
  bundle.targetAppVersion
    ? `${bundle.platform}_${bundle.channel}_${bundle.targetAppVersion}`
    : null;

const bundleMatchesQueryWhere = (
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  if (where.id?.eq !== undefined && bundle.id !== where.id.eq) return false;
  if (where.id?.gt !== undefined && bundle.id.localeCompare(where.id.gt) <= 0)
    return false;
  if (where.id?.gte !== undefined && bundle.id.localeCompare(where.id.gte) < 0)
    return false;
  if (where.id?.lt !== undefined && bundle.id.localeCompare(where.id.lt) >= 0)
    return false;
  if (where.id?.lte !== undefined && bundle.id.localeCompare(where.id.lte) > 0)
    return false;
  if (where.id?.in && !where.id.in.includes(bundle.id)) return false;
  if (where.targetAppVersionNotNull && bundle.targetAppVersion === null) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  return true;
};

const sortBundles = (
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
) => {
  const direction = orderBy?.direction ?? "desc";
  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
};

const applyFirestoreQueryableFilters = (
  query: admin.firestore.Query<FirestoreData>,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  let nextQuery = query;

  if (where?.channel) {
    nextQuery = nextQuery.where("channel", "==", where.channel);
  }
  if (where?.platform) {
    nextQuery = nextQuery.where("platform", "==", where.platform);
  }
  if (where?.enabled !== undefined) {
    nextQuery = nextQuery.where("enabled", "==", where.enabled);
  }
  if (where?.fingerprintHash !== undefined && where.fingerprintHash !== null) {
    nextQuery = nextQuery.where(
      "fingerprint_hash",
      "==",
      where.fingerprintHash,
    );
  }
  if (
    where?.targetAppVersion !== undefined &&
    where.targetAppVersion !== null
  ) {
    nextQuery = nextQuery.where(
      "target_app_version",
      "==",
      where.targetAppVersion,
    );
  }
  if (where?.id?.eq) {
    nextQuery = nextQuery.where("id", "==", where.id.eq);
  }
  if (where?.id?.gt) {
    nextQuery = nextQuery.where("id", ">", where.id.gt);
  }
  if (where?.id?.gte) {
    nextQuery = nextQuery.where("id", ">=", where.id.gte);
  }
  if (where?.id?.lt) {
    nextQuery = nextQuery.where("id", "<", where.id.lt);
  }
  if (where?.id?.lte) {
    nextQuery = nextQuery.where("id", "<=", where.id.lte);
  }

  return nextQuery;
};

const chunkValues = <T>(values: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const paginateItems = <TItem>({
  cursor,
  getCursor,
  items,
  limit,
  page,
}: {
  readonly cursor?: { readonly after?: string; readonly before?: string };
  readonly getCursor: (item: TItem) => string;
  readonly items: readonly TItem[];
  readonly limit: number;
  readonly page?: number;
}): CursorPage<TItem> => {
  const total = items.length;
  const pageOffset = page ? (Math.max(1, page) - 1) * limit : undefined;
  let startIndex =
    pageOffset === undefined ? 0 : Math.min(pageOffset, Math.max(0, total));
  let endIndex = limit > 0 ? startIndex + limit : total;

  if (pageOffset === undefined && cursor?.after) {
    const afterIndex = items.findIndex(
      (item) => getCursor(item) === cursor.after,
    );
    startIndex = afterIndex >= 0 ? afterIndex + 1 : total;
    endIndex = limit > 0 ? startIndex + limit : total;
  } else if (pageOffset === undefined && cursor?.before) {
    const beforeIndex = items.findIndex(
      (item) => getCursor(item) === cursor.before,
    );
    endIndex = beforeIndex >= 0 ? beforeIndex : 0;
    startIndex = limit > 0 ? Math.max(0, endIndex - limit) : 0;
  }

  const data = items.slice(startIndex, endIndex);
  const pagination = calculatePagination(total, {
    limit,
    offset: startIndex,
  });

  return {
    data,
    pagination: {
      ...pagination,
      nextCursor:
        data.length > 0 && startIndex + data.length < total
          ? getCursor(data[data.length - 1]!)
          : null,
      previousCursor:
        data.length > 0 && startIndex > 0 ? getCursor(data[0]!) : null,
    },
  };
};

const convertToBundle = (firestoreData: FirestoreBundleData): Bundle => {
  const rawMetadata = firestoreData.metadata;
  const storedPatches = firestoreData.patches;
  const patches =
    storedPatches && Array.isArray(storedPatches)
      ? storedPatches
      : getBundlePatches({
          metadata: rawMetadata,
          patchBaseBundleId: firestoreData.patch_base_bundle_id ?? null,
          patchBaseFileHash: firestoreData.patch_base_file_hash ?? null,
          patchFileHash: firestoreData.patch_file_hash ?? null,
          patchStorageUri: firestoreData.patch_storage_uri ?? null,
        });
  const primaryPatch = patches[0] ?? null;

  return {
    channel: firestoreData.channel,
    enabled: Boolean(firestoreData.enabled),
    shouldForceUpdate: Boolean(firestoreData.should_force_update),
    fileHash: firestoreData.file_hash,
    gitCommitHash: firestoreData.git_commit_hash,
    id: firestoreData.id,
    message: firestoreData.message,
    platform: firestoreData.platform,
    targetAppVersion: firestoreData.target_app_version,
    storageUri: firestoreData.storage_uri,
    fingerprintHash: firestoreData.fingerprint_hash,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri: firestoreData.manifest_storage_uri ?? null,
    manifestFileHash: firestoreData.manifest_file_hash ?? null,
    assetBaseStorageUri: firestoreData.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId:
      primaryPatch?.baseBundleId ?? firestoreData.patch_base_bundle_id ?? null,
    patchBaseFileHash:
      primaryPatch?.baseFileHash ?? firestoreData.patch_base_file_hash ?? null,
    patchFileHash:
      primaryPatch?.patchFileHash ?? firestoreData.patch_file_hash ?? null,
    patchStorageUri:
      primaryPatch?.patchStorageUri ?? firestoreData.patch_storage_uri ?? null,
    rolloutCohortCount:
      firestoreData.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: firestoreData.target_cohorts ?? null,
  };
};

const toFirestoreBundleData = (bundle: Bundle): FirestoreBundleData => ({
  id: bundle.id,
  channel: bundle.channel,
  enabled: bundle.enabled,
  should_force_update: bundle.shouldForceUpdate,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash || null,
  message: bundle.message || null,
  platform: bundle.platform,
  target_app_version: bundle.targetAppVersion || null,
  storage_uri: bundle.storageUri,
  fingerprint_hash: bundle.fingerprintHash,
  metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
  manifest_storage_uri: getManifestStorageUri(bundle),
  manifest_file_hash: getManifestFileHash(bundle),
  asset_base_storage_uri: getAssetBaseStorageUri(bundle),
  patches: bundle.patches ?? null,
  patch_base_bundle_id: getPatchBaseBundleId(bundle),
  patch_base_file_hash: getPatchBaseFileHash(bundle),
  patch_file_hash: getPatchFileHash(bundle),
  patch_storage_uri: getPatchStorageUri(bundle),
  rollout_cohort_count:
    bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: bundle.targetCohorts ?? null,
});

const databaseBundleRecordToFirestoreData = (
  bundle: DatabaseBundleRecord,
): FirestoreBundleData => toFirestoreBundleData(toBundleReadModel(bundle));

const rowToDatabaseBundleRecord = (firestoreData: FirestoreBundleData) =>
  toDatabaseBundleRecord(convertToBundle(firestoreData));

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? buildBundlePatchId(patch.bundleId, patch.baseBundleId);

const materializePatch = (patch: DatabaseBundlePatch): DatabaseBundlePatch => ({
  ...patch,
  id: getPatchId(patch),
});

const getPatchStringField = (
  patch: DatabaseBundlePatch,
  field: Exclude<
    NonNullable<BundlePatchListQuery["orderBy"]>["field"],
    "orderIndex"
  >,
): string => (field === "id" ? getPatchId(patch) : patch[field]);

const bundleToDatabaseBundlePatches = (bundle: Bundle): DatabaseBundlePatch[] =>
  getBundlePatches(bundle).map((patch, index) => ({
    id: buildBundlePatchId(bundle.id, patch.baseBundleId),
    bundleId: bundle.id,
    baseBundleId: patch.baseBundleId,
    baseFileHash: patch.baseFileHash,
    patchFileHash: patch.patchFileHash,
    patchStorageUri: patch.patchStorageUri,
    orderIndex: index,
  }));

const patchMatchesWhere = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"] | undefined,
) =>
  !where ||
  ((where.id === undefined || getPatchId(patch) === where.id) &&
    (where.bundleId === undefined || patch.bundleId === where.bundleId) &&
    (where.baseBundleId === undefined ||
      patch.baseBundleId === where.baseBundleId) &&
    (where.idIn === undefined || where.idIn.includes(getPatchId(patch))) &&
    (where.bundleIdIn === undefined ||
      where.bundleIdIn.includes(patch.bundleId)) &&
    (where.baseBundleIdIn === undefined ||
      where.baseBundleIdIn.includes(patch.baseBundleId)));

const patchesToFirestoreFields = (
  patches: readonly DatabaseBundlePatch[],
): Partial<FirestoreBundleData> => {
  const sortedPatches = patches
    .slice()
    .sort(
      (left, right) =>
        left.orderIndex - right.orderIndex ||
        left.baseBundleId.localeCompare(right.baseBundleId),
    )
    .map((patch) => ({
      baseBundleId: patch.baseBundleId,
      baseFileHash: patch.baseFileHash,
      patchFileHash: patch.patchFileHash,
      patchStorageUri: patch.patchStorageUri,
    }));
  const primaryPatch = sortedPatches[0] ?? null;
  return {
    patches: sortedPatches,
    patch_base_bundle_id: primaryPatch?.baseBundleId ?? null,
    patch_base_file_hash: primaryPatch?.baseFileHash ?? null,
    patch_file_hash: primaryPatch?.patchFileHash ?? null,
    patch_storage_uri: primaryPatch?.patchStorageUri ?? null,
  };
};

export const firebaseDatabase = createDatabasePlugin({
  name: "firebaseDatabase",
  connect: (config: admin.AppOptions): DatabasePluginCore => {
    let app: admin.app.App;
    try {
      app = admin.app();
    } catch {
      app = admin.initializeApp(config);
    }

    const db = admin.firestore(app);
    const bundlesCollection = db.collection("bundles");
    const targetAppVersionsCollection = db.collection("target_app_versions");
    const channelsCollection = db.collection("channels");

    const writeBundle = async (bundle: DatabaseBundleRecord) => {
      const bundleData = databaseBundleRecordToFirestoreData(bundle);
      await bundlesCollection.doc(bundle.id).set(bundleData, { merge: true });
      await channelsCollection.doc(bundle.channel).set(
        {
          name: bundle.channel,
        },
        { merge: true },
      );
      if (bundle.targetAppVersion) {
        const versionDocId = `${bundle.platform}_${bundle.channel}_${bundle.targetAppVersion}`;
        await targetAppVersionsCollection.doc(versionDocId).set(
          {
            channel: bundle.channel,
            platform: bundle.platform,
            target_app_version: bundle.targetAppVersion,
          },
          { merge: true },
        );
      }
    };

    const cleanupChannel = async (channel: string) => {
      const snapshot = await bundlesCollection
        .where("channel", "==", channel)
        .get();
      if (snapshot.empty) {
        await channelsCollection.doc(channel).delete();
      }
    };

    const cleanupTargetAppVersion = async (bundle: BundleIndexReference) => {
      const versionDocId = getTargetAppVersionDocId(bundle);
      if (!versionDocId || !bundle.targetAppVersion) {
        return;
      }

      const snapshot = await bundlesCollection
        .where("platform", "==", bundle.platform)
        .where("channel", "==", bundle.channel)
        .where("target_app_version", "==", bundle.targetAppVersion)
        .get();
      if (snapshot.empty) {
        await targetAppVersionsCollection.doc(versionDocId).delete();
      }
    };

    const cleanupBundleIndexes = async (bundle: BundleIndexReference) => {
      await Promise.all([
        cleanupChannel(bundle.channel),
        cleanupTargetAppVersion(bundle),
      ]);
    };

    const getAllBundlePatchRecords = async () => {
      const querySnapshot = await bundlesCollection.get();
      return querySnapshot.docs
        .map((doc) => convertToBundle(doc.data() as FirestoreBundleData))
        .flatMap(bundleToDatabaseBundlePatches);
    };

    const getBundlePatchById = async (
      patchId: string,
    ): Promise<DatabaseBundlePatch | null> =>
      (await getAllBundlePatchRecords()).find(
        (patch) => getPatchId(patch) === patchId,
      ) ?? null;

    const replaceBundlePatches = async (
      bundleId: string,
      patches: readonly DatabaseBundlePatch[],
    ) => {
      const bundleRef = bundlesCollection.doc(bundleId);
      const bundleSnap = await bundleRef.get();
      if (!bundleSnap.exists) {
        throw new Error("targetBundleId not found");
      }
      await bundleRef.set(
        patchesToFirestoreFields(patches.map(materializePatch)),
        { merge: true },
      );
    };

    return {
      bundles: {
        async getById({ bundleId }) {
          const bundleSnap = await bundlesCollection.doc(bundleId).get();
          if (!bundleSnap.exists) {
            return null;
          }
          return rowToDatabaseBundleRecord(
            bundleSnap.data() as FirestoreBundleData,
          );
        },

        async list(options) {
          const { where, orderBy } = options;
          let query = applyFirestoreQueryableFilters(bundlesCollection, where);

          query = query.orderBy(
            "id",
            orderBy?.direction === "asc" ? "asc" : "desc",
          );

          const querySnapshot = await query.get();
          const filteredBundles = sortBundles(
            querySnapshot.docs
              .map((doc) => convertToBundle(doc.data() as FirestoreBundleData))
              .filter((bundle) => bundleMatchesQueryWhere(bundle, where)),
            orderBy,
          );
          const page = paginateItems({
            items: filteredBundles,
            limit: options.limit,
            cursor: options.cursor,
            page: options.page,
            getCursor: (bundle) => bundle.id,
          });

          return {
            ...page,
            data: page.data.map((bundle) => toDatabaseBundleRecord(bundle)),
          };
        },

        async insert({ bundle }) {
          await writeBundle(bundle);
        },

        async update({ bundleId, patch }) {
          const bundleSnap = await bundlesCollection.doc(bundleId).get();
          if (!bundleSnap.exists) {
            throw new Error("targetBundleId not found");
          }
          const currentBundle = rowToDatabaseBundleRecord(
            bundleSnap.data() as FirestoreBundleData,
          );
          await writeBundle({
            ...currentBundle,
            ...patch,
            id: bundleId,
          });
          await cleanupBundleIndexes(currentBundle);
        },

        async delete({ bundleId }) {
          const bundleSnap = await bundlesCollection.doc(bundleId).get();
          const currentBundle = bundleSnap.exists
            ? rowToDatabaseBundleRecord(
                bundleSnap.data() as FirestoreBundleData,
              )
            : null;
          await bundlesCollection.doc(bundleId).delete();
          if (currentBundle) {
            await cleanupBundleIndexes(currentBundle);
          }
        },
      },

      bundlePatches: {
        async list(options: BundlePatchListQuery) {
          const patches = (await getAllBundlePatchRecords())
            .filter((patch) => patchMatchesWhere(patch, options.where))
            .sort((left, right) => {
              const direction = options.orderBy?.direction ?? "asc";
              const field = options.orderBy?.field ?? "orderIndex";
              const result =
                field === "orderIndex"
                  ? left.orderIndex - right.orderIndex
                  : getPatchStringField(left, field).localeCompare(
                      getPatchStringField(right, field),
                    );
              return direction === "asc" ? result : -result;
            });

          return paginateItems({
            items: patches,
            limit: options.limit,
            cursor: options.cursor,
            getCursor: getPatchId,
          });
        },

        getById: async ({ patchId }) => getBundlePatchById(patchId),

        async insert({ patch }) {
          const nextPatch = materializePatch(patch);
          const bundleSnap = await bundlesCollection
            .doc(nextPatch.bundleId)
            .get();
          if (!bundleSnap.exists) {
            throw new Error("targetBundleId not found");
          }
          const bundle = convertToBundle(
            bundleSnap.data() as FirestoreBundleData,
          );
          const patches = bundleToDatabaseBundlePatches(bundle).filter(
            (currentPatch) => getPatchId(currentPatch) !== nextPatch.id,
          );
          await replaceBundlePatches(nextPatch.bundleId, [
            ...patches,
            nextPatch,
          ]);
        },

        async update({ patchId, patch }) {
          const currentPatch = await getBundlePatchById(patchId);
          if (!currentPatch) {
            return;
          }
          const bundleSnap = await bundlesCollection
            .doc(currentPatch.bundleId)
            .get();
          if (!bundleSnap.exists) {
            return;
          }
          const bundle = convertToBundle(
            bundleSnap.data() as FirestoreBundleData,
          );
          const nextPatch = materializePatch({
            ...currentPatch,
            ...patch,
            id: patchId,
          });
          const patches = bundleToDatabaseBundlePatches(bundle).map(
            (candidate) =>
              getPatchId(candidate) === patchId ? nextPatch : candidate,
          );
          await replaceBundlePatches(currentPatch.bundleId, patches);
        },

        async delete({ patchId }) {
          const currentPatch = await getBundlePatchById(patchId);
          if (!currentPatch) {
            return;
          }
          const bundleSnap = await bundlesCollection
            .doc(currentPatch.bundleId)
            .get();
          if (!bundleSnap.exists) {
            return;
          }
          const bundle = convertToBundle(
            bundleSnap.data() as FirestoreBundleData,
          );
          const patches = bundleToDatabaseBundlePatches(bundle).filter(
            (patch) => getPatchId(patch) !== patchId,
          );
          await replaceBundlePatches(currentPatch.bundleId, patches);
        },
      },

      updateInfo: {
        async get(args) {
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;

          if (args._updateStrategy === "appVersion") {
            const querySnapshot = await targetAppVersionsCollection
              .where("platform", "==", args.platform)
              .where("channel", "==", channel)
              .select("target_app_version")
              .get();

            const targetAppVersions = Array.from(
              new Set(
                querySnapshot.docs
                  .map(
                    (doc) =>
                      doc.data().target_app_version as string | undefined,
                  )
                  .filter((version): version is string => Boolean(version)),
              ),
            );
            const compatibleAppVersions = filterCompatibleAppVersions(
              targetAppVersions,
              args.appVersion,
            );
            const results =
              compatibleAppVersions.length > 0
                ? await Promise.all(
                    chunkValues(compatibleAppVersions, 10).map((versions) =>
                      bundlesCollection
                        .where("platform", "==", args.platform)
                        .where("channel", "==", channel)
                        .where("enabled", "==", true)
                        .where("id", ">=", minBundleId)
                        .where("target_app_version", "in", versions)
                        .get(),
                    ),
                  )
                : [];
            const bundles = results.flatMap((snapshot) =>
              snapshot.docs.map((doc) =>
                convertToBundle(doc.data() as FirestoreBundleData),
              ),
            );

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles,
            });
          }

          const querySnapshot = await bundlesCollection
            .where("platform", "==", args.platform)
            .where("channel", "==", channel)
            .where("enabled", "==", true)
            .where("id", ">=", minBundleId)
            .where("fingerprint_hash", "==", args.fingerprintHash)
            .get();

          const bundles = querySnapshot.docs.map((doc) =>
            convertToBundle(doc.data() as FirestoreBundleData),
          );

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles,
          });
        },
      },
    };
  },
});
