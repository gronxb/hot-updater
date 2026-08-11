import { NIL_UUID, type Bundle, type GetBundlesArgs } from "@hot-updater/core";
import {
  createDatabasePlugin,
  type DatabasePlugin,
  type DatabasePluginImplementation,
  resolveUpdateInfoFromBundles,
  rowsToBundles,
  type BundlePatchRow,
  type BundleRow,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  getApp,
  getApps,
  initializeApp,
  type AppOptions,
} from "firebase-admin/app";
import {
  getFirestore as getAdminFirestore,
  type DocumentData,
  type Firestore,
  type QuerySnapshot,
} from "firebase-admin/firestore";

import {
  parseFirebaseBundleRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import {
  createFirebaseDatabaseCollections,
  type FirebaseDatabaseCollections,
  loadFirebaseDatabaseSnapshot,
  loadFirebaseTransactionSnapshot,
  migrateFirebaseDatabase,
  persistFirebaseDatabaseSnapshot,
  requireFirebaseDocumentKey,
} from "./firebaseDatabasePersistence";
import {
  cloneFirebaseDatabaseSnapshot,
  createFirebaseDatabaseState,
} from "./firebaseDatabaseState";
import { createFirebaseUniversalComponentDataAdapter } from "./firebaseUniversalComponentData";

type FirebaseMutation<TResult> = (
  database: TransactionDatabasePluginImplementation,
) => Promise<TResult>;

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
    requireFirebaseDocumentKey(
      "bundles",
      document.id,
      parseFirebaseBundleRow(document.data(), `bundles/${document.id}`),
    ),
  );

const parsePatches = (
  snapshot: QuerySnapshot<DocumentData>,
): BundlePatchRow[] =>
  snapshot.docs.map((document) =>
    requireFirebaseDocumentKey(
      "bundle_patches",
      document.id,
      parseFirebasePatchRow(document.data(), `bundle_patches/${document.id}`),
    ),
  );

const loadFirebaseUpdateBundles = async (
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

const exactId = (
  input: Parameters<DatabasePluginImplementation["findOne"]>[0],
): string | undefined => {
  if (input.where?.length !== 1) return undefined;
  const [condition] = input.where;
  return condition.field === "id" &&
    (condition.operator === undefined || condition.operator === "eq") &&
    typeof condition.value === "string"
    ? condition.value
    : undefined;
};

export function firebaseDatabase(config: AppOptions): DatabasePlugin {
  const getFirestore = (): Firestore => {
    const app = getApps().length ? getApp() : initializeApp(config);
    return getAdminFirestore(app);
  };
  const database = createDatabasePlugin({
    name: "firebaseDatabase",
    plugin: (): DatabasePluginImplementation => {
      const db = getFirestore();
      const collections = createFirebaseDatabaseCollections(db);
      let migration: Promise<void> | undefined;

      const ensureMigrated = (): Promise<void> => {
        migration ??= migrateFirebaseDatabase(db, collections).catch(
          (error) => {
            migration = undefined;
            throw error;
          },
        );
        return migration;
      };

      const mutate = async <TResult>(
        operation: FirebaseMutation<TResult>,
      ): Promise<TResult> => {
        await ensureMigrated();
        return db.runTransaction(async (transaction) => {
          const before = await loadFirebaseTransactionSnapshot(
            transaction,
            collections,
          );
          const after = cloneFirebaseDatabaseSnapshot(before);
          const database = createFirebaseDatabaseState(after);
          const result = await operation(database);
          persistFirebaseDatabaseSnapshot({
            transaction,
            collections,
            before,
            after,
          });
          return result;
        });
      };

      const read = async <TResult>(
        operation: FirebaseMutation<TResult>,
      ): Promise<TResult> => {
        await ensureMigrated();
        const snapshot = await loadFirebaseDatabaseSnapshot(collections);
        return operation(createFirebaseDatabaseState(snapshot));
      };

      return {
        create: (input) => mutate((database) => database.create(input)),
        update: (input) => mutate((database) => database.update(input)),
        delete: (input) => mutate((database) => database.delete(input)),
        count: (input) => read((database) => database.count(input)),
        findOne: async (input) => {
          const id = exactId(input);
          if (id === undefined) {
            return read((database) => database.findOne(input));
          }
          await ensureMigrated();
          switch (input.model) {
            case "bundles": {
              const document = await collections.bundles.doc(id).get();
              return document.exists
                ? requireFirebaseDocumentKey(
                    "bundles",
                    document.id,
                    parseFirebaseBundleRow(
                      document.data(),
                      `bundles/${document.id}`,
                    ),
                  )
                : null;
            }
            case "bundle_patches": {
              const document = await collections.bundlePatches.doc(id).get();
              return document.exists
                ? requireFirebaseDocumentKey(
                    "bundle_patches",
                    document.id,
                    parseFirebasePatchRow(
                      document.data(),
                      `bundle_patches/${document.id}`,
                    ),
                  )
                : null;
            }
          }
        },
        findMany: (input) => read((database) => database.findMany(input)),
        getChannels: async () => {
          await ensureMigrated();
          const snapshot = await collections.bundles.select("channel").get();
          return [
            ...new Set(
              snapshot.docs.map((document) => String(document.get("channel"))),
            ),
          ].sort();
        },
        getUpdateInfo: async (args) => {
          await ensureMigrated();
          return resolveUpdateInfoFromBundles({
            args,
            bundles: await loadFirebaseUpdateBundles(collections, args),
          });
        },
        transaction: (callback) => mutate(callback),
      };
    },
  });
  return {
    ...database,
    componentData: createFirebaseUniversalComponentDataAdapter(getFirestore()),
  };
}
