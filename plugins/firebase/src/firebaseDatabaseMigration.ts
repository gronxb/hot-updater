import {
  type DocumentData,
  type DocumentReference,
  FieldValue,
  type Firestore,
  type Timestamp,
} from "firebase-admin/firestore";

import {
  parseFirebaseLegacyPatchRows,
  parseFirebaseMigratingBundleRow,
  parseFirebasePatchRow,
} from "./firebaseDatabaseParser";
import type { FirebaseDatabaseCollections } from "./firebaseDatabasePersistence";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";

type FirebaseMigrationWrite =
  | {
      readonly kind: "create";
      readonly reference: DocumentReference<DocumentData>;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "update";
      readonly reference: DocumentReference<DocumentData>;
      readonly updateTime: Timestamp;
      readonly value: Readonly<Record<string, unknown>>;
    };

const requireUpdateTime = (
  document: { readonly updateTime?: Timestamp },
  source: string,
): Timestamp => {
  if (!document.updateTime) {
    throw new Error(`Missing update time for ${source}.`);
  }
  return document.updateTime;
};

const migrateFirebaseDatabaseAttempt = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  const versionDocument = collections.settings.doc("database_adapter_version");
  const version = await versionDocument.get();
  if (version.data()?.version === 2) return;

  const [bundles, patches] = await Promise.all([
    collections.bundles.get(),
    collections.bundlePatches.get(),
  ]);
  const bundleIds = new Set(bundles.docs.map(({ id }) => id));
  const patchIds = new Set(patches.docs.map(({ id }) => id));
  const patchWrites: FirebaseMigrationWrite[] = [];
  const bundleWrites: FirebaseMigrationWrite[] = [];

  for (const document of patches.docs) {
    const patch = parseFirebasePatchRow(
      document.data(),
      `bundle_patches/${document.id}`,
    );
    if (!bundleIds.has(patch.bundle_id)) {
      throw new FirebaseDatabaseConstraintError(
        "bundle_patches.bundle_id.foreign-key",
      );
    }
    if (!bundleIds.has(patch.base_bundle_id)) {
      throw new FirebaseDatabaseConstraintError(
        "bundle_patches.base_bundle_id.foreign-key",
      );
    }
  }

  for (const document of bundles.docs) {
    const value: unknown = document.data();
    const bundle = parseFirebaseMigratingBundleRow(
      value,
      `bundles/${document.id}`,
    );
    const legacyPatches = parseFirebaseLegacyPatchRows(
      value,
      bundle.id,
      `bundles/${document.id}`,
    );
    for (const patch of legacyPatches) {
      if (!bundleIds.has(patch.base_bundle_id)) {
        throw new FirebaseDatabaseConstraintError(
          "bundle_patches.base_bundle_id.foreign-key",
        );
      }
      if (!patchIds.has(patch.id)) {
        patchWrites.push({
          kind: "create",
          reference: collections.bundlePatches.doc(patch.id),
          value: { ...patch },
        });
        patchIds.add(patch.id);
      }
    }
    bundleWrites.push({
      kind: "update",
      reference: document.ref,
      updateTime: requireUpdateTime(document, `bundles/${document.id}`),
      value: {
        ...bundle,
        patches: FieldValue.delete(),
        patchBaseBundleId: FieldValue.delete(),
        patchBaseFileHash: FieldValue.delete(),
        patchFileHash: FieldValue.delete(),
        patchStorageUri: FieldValue.delete(),
      },
    });
  }

  const writes: FirebaseMigrationWrite[] = [
    ...patchWrites,
    ...bundleWrites,
    version.exists
      ? {
          kind: "update",
          reference: versionDocument,
          updateTime: requireUpdateTime(version, versionDocument.path),
          value: { version: 2 },
        }
      : {
          kind: "create",
          reference: versionDocument,
          value: { version: 2 },
        },
  ];
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 400)) {
      if (write.kind === "create") {
        batch.create(write.reference, write.value);
      } else {
        batch.update(write.reference, write.value, {
          lastUpdateTime: write.updateTime,
        });
      }
    }
    await batch.commit();
  }
};

const isFirebaseMigrationConflict = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return code === 6 || code === 9 || code === 10;
};

export const migrateFirebaseDatabase = async (
  db: Firestore,
  collections: FirebaseDatabaseCollections,
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await migrateFirebaseDatabaseAttempt(db, collections);
      return;
    } catch (error) {
      const version = await collections.settings
        .doc("database_adapter_version")
        .get();
      if (version.data()?.version === 2) return;
      if (!isFirebaseMigrationConflict(error) || attempt === 2) throw error;
    }
  }
};
