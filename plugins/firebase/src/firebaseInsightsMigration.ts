import { compareInsightsText } from "@hot-updater/plugin-core";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";

import type { FirebaseDatabaseConfig } from "./firebaseDatabase";
import { parseFirebaseInsightsInstallationRow } from "./firebaseDatabaseParser";
import {
  createFirebaseDatabaseCollections,
  firebaseInstallationDocumentId,
  FirebaseDatabaseAdapterVersionError,
  migrateFirebaseDatabase,
  requireFirebaseDocumentKey,
} from "./firebaseDatabasePersistence";
import { FirebaseDatabaseConstraintError } from "./firebaseDatabaseState";
import { FIREBASE_LEGACY_INSTALLATIONS_COLLECTION } from "./firebaseInfrastructureNames";

/**
 * Upgrade adapter 4 Insights installation keys to adapter 5 without deleting
 * legacy data. Stop the old server's ingestion before running this operation,
 * deploy the updated Firestore indexes, then start the updated server.
 * Copies at most 200 installation rows per transaction and safely resumes
 * after a failed run. Normal requests never perform this data migration.
 */
export const migrateFirebaseInsights = async (
  config: FirebaseDatabaseConfig,
): Promise<void> => {
  const app = getApps().length ? getApp() : initializeApp(config);
  const db = getFirestore(app);
  const collections = createFirebaseDatabaseCollections(db);
  const versionReference = collections.settings.doc("database_adapter_version");
  const version = (await versionReference.get()).data()?.version;
  if (version !== 4) {
    await migrateFirebaseDatabase(db, collections);
    return;
  }

  let afterDocumentId: string | undefined;
  const legacy = db.collection(FIREBASE_LEGACY_INSTALLATIONS_COLLECTION);
  for (;;) {
    let query = legacy.orderBy(FieldPath.documentId()).limit(200);
    if (afterDocumentId !== undefined)
      query = query.startAfter(afterDocumentId);
    const page = await query.get();
    if (page.empty) break;
    const rows = page.docs.map((document) => {
      const row = parseFirebaseInsightsInstallationRow(
        document.data(),
        `${FIREBASE_LEGACY_INSTALLATIONS_COLLECTION}/${document.id}`,
      );
      if (row.install_id !== document.id)
        throw new FirebaseDatabaseConstraintError(
          "legacy_bundle_installations.id.document-key",
        );
      return row;
    });
    const references = rows.map((row) =>
      collections.bundleInstallations.doc(
        firebaseInstallationDocumentId(row.install_id),
      ),
    );
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.getAll(...references);
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const document = existing[index]!;
        const current = document.exists
          ? requireFirebaseDocumentKey(
              "bundle_installations",
              document.id,
              parseFirebaseInsightsInstallationRow(
                document.data(),
                `bundle_installations/${document.id}`,
              ),
            )
          : null;
        if (
          current === null ||
          row.received_at_ms > current.received_at_ms ||
          (row.received_at_ms === current.received_at_ms &&
            compareInsightsText(row.id, current.id) > 0)
        ) {
          transaction.set(references[index]!, row);
        }
      }
    });
    afterDocumentId = page.docs.at(-1)!.id;
  }
  await db.runTransaction(async (transaction) => {
    const current = (await transaction.get(versionReference)).data()?.version;
    if (current !== 4 && current !== 5)
      throw new FirebaseDatabaseAdapterVersionError(current);
    transaction.update(versionReference, { version: 5 });
  });
};
