import {
  createTelemetryAnalyticsEvent,
  deriveTelemetryLifecycleMetrics,
  type TelemetryAnalyticsEventRow,
} from "@hot-updater/plugin-core";
import type { Firestore } from "firebase-admin/firestore";

import {
  LIFECYCLE_EVENTS_COLLECTION,
  LifecycleStatus,
  TELEMETRY_KEY_DOC_ID,
  TELEMETRY_KEYS_COLLECTION,
  readString,
  type FirebaseTelemetryOperations,
} from "./firebaseTelemetryTypes";

const assertLifecyclePayload = (
  payload: Parameters<FirebaseTelemetryOperations["insertLifecycleEvent"]>[0],
) => {
  if (
    payload.status === LifecycleStatus.Recovered &&
    !payload.crashedBundleId
  ) {
    throw new TypeError("Recovered lifecycle events require crashedBundleId.");
  }
};

const toFirestoreRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Analytics event payload must be a Firestore object.");
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
};

export const createFirebaseTelemetryOperations = (
  firestore: Firestore,
): FirebaseTelemetryOperations => {
  const keyDocument = firestore
    .collection(TELEMETRY_KEYS_COLLECTION)
    .doc(TELEMETRY_KEY_DOC_ID);
  const eventsCollection = firestore.collection(LIFECYCLE_EVENTS_COLLECTION);

  return {
    async getTelemetryKeyCredential() {
      const snapshot = await keyDocument.get();
      const data = snapshot.data();
      const keyHash = readString(data ?? {}, "key_hash");
      const telemetryKeySuffix = readString(data ?? {}, "key_suffix");

      return keyHash && telemetryKeySuffix
        ? {
            active: data?.active === true,
            keyHash,
            telemetryKeySuffix,
          }
        : null;
    },

    async upsertTelemetryKeyCredential(credential) {
      const now = new Date().toISOString();
      await keyDocument.set({
        active: credential.active,
        created_at: now,
        key_hash: credential.keyHash,
        key_suffix: credential.telemetryKeySuffix,
        updated_at: now,
      });
    },

    async setTelemetryKeyActive(active) {
      await keyDocument.set(
        {
          active,
          updated_at: new Date().toISOString(),
        },
        { merge: true },
      );
    },

    async insertLifecycleEvent(payload) {
      assertLifecyclePayload(payload);
      const event = createTelemetryAnalyticsEvent(payload);
      return await firestore.runTransaction(async (transaction) => {
        const eventRef = eventsCollection.doc(event.id);
        const eventSnapshot = await transaction.get(eventRef);

        if (eventSnapshot.exists) {
          return { accepted: true, deduped: true };
        }

        transaction.set(eventRef, {
          event_type: event.eventType,
          id: event.id,
          observed_at: event.observedAt,
          payload: toFirestoreRecord(event.payload),
          received_at: event.receivedAt,
        });

        return { accepted: true, deduped: false };
      });
    },

    async getLifecycleMetrics() {
      const eventsSnapshot = await eventsCollection.get();
      return deriveTelemetryLifecycleMetrics(
        eventsSnapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            eventType: readString(data, "event_type") ?? "",
            id: readString(data, "id") ?? doc.id,
            observedAt: readString(data, "observed_at") ?? "",
            payload: data.payload,
            receivedAt: readString(data, "received_at") ?? "",
          };
        }) satisfies TelemetryAnalyticsEventRow[],
      );
    },
  };
};
