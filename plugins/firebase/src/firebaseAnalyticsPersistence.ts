import {
  ANALYTICS_SCHEMA_KEY,
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSchemaNotReadyError,
  type AnalyticsPersistence,
} from "@hot-updater/analytics/provider";
import type {
  CollectionReference,
  DocumentData,
} from "firebase-admin/firestore";

import { parseFirebaseAnalyticsDocument } from "./firebaseAnalyticsDocument";
import { validateFirebaseAnalyticsReadiness } from "./firebaseAnalyticsMigration";

const SETTINGS_COLLECTION = "private_hot_updater_settings";

const validateMarker = async (
  collection: CollectionReference<DocumentData>,
): Promise<void> => {
  const snapshot = await collection.firestore
    .collection(SETTINGS_COLLECTION)
    .doc(ANALYTICS_SCHEMA_KEY)
    .get();
  const data = snapshot.data();
  const value =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "value")
      : undefined;
  const componentVersion = typeof value === "string" ? value : null;
  if (
    typeof data !== "object" ||
    data === null ||
    Reflect.ownKeys(data).length !== 1 ||
    componentVersion !== ANALYTICS_SCHEMA_VERSION
  ) {
    throw new AnalyticsSchemaNotReadyError({
      componentVersion,
      fingerprint: null,
      legacyVersion: null,
    });
  }
};

export function createFirebaseAnalyticsPersistence(
  collection: CollectionReference<DocumentData>,
): AnalyticsPersistence {
  let physicalReadiness: Promise<void> | undefined;
  const ensureReady = async (): Promise<void> => {
    const existing = physicalReadiness;
    if (existing === undefined) {
      const validation = validateFirebaseAnalyticsReadiness(
        collection.firestore,
      );
      physicalReadiness = validation;
      try {
        await validation;
      } catch (error: unknown) {
        physicalReadiness = undefined;
        throw error;
      }
      return;
    }
    try {
      await validateMarker(collection);
    } catch (error: unknown) {
      physicalReadiness = undefined;
      throw error;
    }
    await existing;
  };

  return {
    async append(row) {
      await ensureReady();
      await collection.doc(row.id).create(row);
    },
    async scan(input) {
      await ensureReady();
      let query = collection
        .where("received_at_ms", "<", input.beforeReceivedAtMs)
        .orderBy("received_at_ms", "asc")
        .orderBy("id", "asc")
        .limit(input.limit);
      if (input.after !== undefined) {
        query = query.startAfter(input.after.receivedAtMs, input.after.id);
      }
      const snapshot = await query.get();
      return snapshot.docs.map((document) =>
        parseFirebaseAnalyticsDocument(document.id, document.data()),
      );
    },
  };
}
