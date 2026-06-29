import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Firestore } from "firebase-admin/firestore";

import {
  LIFECYCLE_BUCKETS_COLLECTION,
  LIFECYCLE_EVENTS_COLLECTION,
  LIFECYCLE_METRICS_COLLECTION,
  LifecycleStatus,
  TELEMETRY_KEY_BYTES,
  TELEMETRY_KEY_DOC_ID,
  TELEMETRY_KEY_PREFIX,
  TELEMETRY_KEY_SUFFIX_LENGTH,
  TELEMETRY_KEYS_COLLECTION,
  isTelemetryKeyFormat,
  parsePlatform,
  readCount,
  readString,
  type FirebaseTelemetryOperations,
  type LifecycleStatusValue,
  type TelemetryKeyResult,
} from "./firebaseTelemetryTypes";

const hashTelemetryKey = (telemetryKey: string): string =>
  createHash("sha256").update(telemetryKey).digest("hex");

const createTelemetryKey = (): TelemetryKeyResult => {
  const telemetryKey = `${TELEMETRY_KEY_PREFIX}${randomBytes(
    TELEMETRY_KEY_BYTES,
  ).toString("base64url")}`;

  return {
    telemetryKey,
    telemetryKeySuffix: telemetryKey.slice(-TELEMETRY_KEY_SUFFIX_LENGTH),
  };
};

const isSameHash = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const metricIncrementFor = (
  status: LifecycleStatusValue,
): { readonly active: number; readonly recovered: number } => {
  switch (status) {
    case LifecycleStatus.Active:
      return { active: 1, recovered: 0 };
    case LifecycleStatus.Recovered:
      return { active: 0, recovered: 1 };
  }
};

const bucketStartFor = (observedAt: string): string => {
  const date = new Date(observedAt);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};

export const createFirebaseTelemetryOperations = (
  firestore: Firestore,
): FirebaseTelemetryOperations => {
  const keyDocument = firestore
    .collection(TELEMETRY_KEYS_COLLECTION)
    .doc(TELEMETRY_KEY_DOC_ID);
  const eventsCollection = firestore.collection(LIFECYCLE_EVENTS_COLLECTION);
  const metricsCollection = firestore.collection(LIFECYCLE_METRICS_COLLECTION);
  const bucketsCollection = firestore.collection(LIFECYCLE_BUCKETS_COLLECTION);

  const writeTelemetryKey = async (): Promise<TelemetryKeyResult> => {
    const telemetryKey = createTelemetryKey();
    await keyDocument.set({
      telemetry_key_hash: hashTelemetryKey(telemetryKey.telemetryKey),
      telemetry_key_suffix: telemetryKey.telemetryKeySuffix,
    });
    return telemetryKey;
  };

  return {
    issueTelemetryKey: writeTelemetryKey,
    rotateTelemetryKey: writeTelemetryKey,

    async authenticateTelemetryKey(telemetryKey) {
      if (!isTelemetryKeyFormat(telemetryKey)) return false;

      const snapshot = await keyDocument.get();
      const data = snapshot.data();
      const storedHash =
        typeof data?.telemetry_key_hash === "string"
          ? data.telemetry_key_hash
          : undefined;

      if (!storedHash) return false;
      return isSameHash(hashTelemetryKey(telemetryKey), storedHash);
    },

    async recordLifecycleEvent(payload) {
      return await firestore.runTransaction(async (transaction) => {
        const eventRef = eventsCollection.doc(payload.eventId);
        const metricRef = metricsCollection.doc(payload.bundleId);
        const bucketStart = bucketStartFor(payload.observedAt);
        const bucketRef = bucketsCollection.doc(
          `${payload.bundleId}:${bucketStart}`,
        );
        const eventSnapshot = await transaction.get(eventRef);

        if (eventSnapshot.exists) {
          return { accepted: true, deduped: true };
        }

        const [metricSnapshot, bucketSnapshot] = await Promise.all([
          transaction.get(metricRef),
          transaction.get(bucketRef),
        ]);
        const metricData = metricSnapshot.data();
        const bucketData = bucketSnapshot.data();
        const increment = metricIncrementFor(payload.status);
        const nextMetricActive =
          readCount(metricData?.active) + increment.active;
        const nextMetricRecovered =
          readCount(metricData?.recovered) + increment.recovered;
        const nextBucketActive =
          readCount(bucketData?.active) + increment.active;
        const nextBucketRecovered =
          readCount(bucketData?.recovered) + increment.recovered;

        transaction.set(eventRef, {
          bundle_id: payload.bundleId,
          channel: payload.channel,
          crashed_bundle_id: payload.crashedBundleId ?? null,
          event_id: payload.eventId,
          install_id: payload.installId,
          observed_at: payload.observedAt,
          platform: payload.platform,
          status: payload.status,
        });
        transaction.set(metricRef, {
          active: nextMetricActive,
          bundle_id: payload.bundleId,
          channel: payload.channel,
          last_seen_at: payload.observedAt,
          platform: payload.platform,
          recovered: nextMetricRecovered,
        });
        transaction.set(bucketRef, {
          active: nextBucketActive,
          bucket_start: bucketStart,
          bundle_id: payload.bundleId,
          recovered: nextBucketRecovered,
        });

        return { accepted: true, deduped: false };
      });
    },

    async readLifecycleMetrics() {
      const [metricsSnapshot, bucketsSnapshot] = await Promise.all([
        metricsCollection.get(),
        bucketsCollection.get(),
      ]);
      const bundles = metricsSnapshot.docs
        .map((doc) => {
          const data = doc.data();
          return {
            active: readCount(data.active),
            bundleId: readString(data, "bundle_id") ?? doc.id,
            channel: readString(data, "channel"),
            lastSeenAt: readString(data, "last_seen_at") ?? null,
            platform: parsePlatform(readString(data, "platform")),
            recovered: readCount(data.recovered),
          };
        })
        .sort((left, right) => left.bundleId.localeCompare(right.bundleId));
      const series = bucketsSnapshot.docs
        .map((doc) => {
          const data = doc.data();
          return {
            active: readCount(data.active),
            bucketStart: readString(data, "bucket_start") ?? "",
            bundleId: readString(data, "bundle_id") ?? doc.id,
            recovered: readCount(data.recovered),
          };
        })
        .filter((point) => point.bucketStart.length > 0)
        .sort(
          (left, right) =>
            left.bucketStart.localeCompare(right.bucketStart) ||
            left.bundleId.localeCompare(right.bundleId),
        );

      return {
        bundles,
        series,
        totals: bundles.reduce(
          (totals, bundle) => ({
            active: totals.active + bundle.active,
            recovered: totals.recovered + bundle.recovered,
          }),
          { active: 0, recovered: 0 },
        ),
      };
    },
  };
};
