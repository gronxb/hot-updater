import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import {
  createFirebaseTelemetryApp,
  createFirebaseTelemetryOperations,
  createNotifyAppReadyResult,
} from "./firebaseTelemetry";

const PROJECT_ID = "firebase-telemetry-test";

const { firestore } = createFirestoreMock(PROJECT_ID);

const clearCollection = async (collectionName: string) => {
  const snapshot = await firestore.collection(collectionName).get();
  const batch = firestore.batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
};

const createLifecyclePayload = (
  overrides: Partial<{
    readonly bundleId: string;
    readonly crashedBundleId: string;
    readonly eventId: string;
    readonly status: "ACTIVE" | "RECOVERED";
  }> = {},
) => ({
  bundleId: overrides.bundleId ?? `bundle-${randomUUID()}`,
  channel: "production",
  crashedBundleId: overrides.crashedBundleId,
  eventId: overrides.eventId ?? randomUUID(),
  installId: randomUUID(),
  observedAt: "2026-06-29T00:00:00.000Z",
  platform: "ios",
  status: overrides.status ?? "ACTIVE",
});

const createNotifyRequest = (
  telemetryKey: string,
  payload: ReturnType<typeof createLifecyclePayload> = createLifecyclePayload(),
  init: {
    readonly headers?: Record<string, string>;
    readonly query?: string;
  } = {},
) =>
  new Request(
    `https://runtime.example.com/api/notify-app-ready${init.query ?? ""}`,
    {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "x-hot-updater-telemetry-key": telemetryKey,
        ...init.headers,
      },
      method: "POST",
    },
  );

describe("firebase telemetry", () => {
  beforeEach(async () => {
    await clearCollection("telemetry_keys");
    await clearCollection("bundle_lifecycle_events");
    await clearCollection("bundle_lifecycle_metrics");
    await clearCollection("bundle_lifecycle_metric_buckets");
  });

  it("writes only telemetry key hash and suffix when issuing and rotating", async () => {
    const telemetry = createFirebaseTelemetryOperations(firestore);

    const issued = await telemetry.issueTelemetryKey();
    const issuedDocument = await firestore
      .collection("telemetry_keys")
      .doc("current")
      .get();

    expect(issued.telemetryKey.startsWith("hutk_")).toBe(true);
    expect(issued.telemetryKeySuffix).toBe(issued.telemetryKey.slice(-8));
    expect(issuedDocument.data()).toEqual({
      telemetry_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      telemetry_key_suffix: issued.telemetryKeySuffix,
    });
    expect(Object.values(issuedDocument.data() ?? {})).not.toContain(
      issued.telemetryKey,
    );

    const rotated = await telemetry.rotateTelemetryKey();
    const rotatedDocument = await firestore
      .collection("telemetry_keys")
      .doc("current")
      .get();

    expect(rotated.telemetryKey).not.toBe(issued.telemetryKey);
    expect(rotatedDocument.data()).toEqual({
      telemetry_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      telemetry_key_suffix: rotated.telemetryKeySuffix,
    });
    expect(Object.values(rotatedDocument.data() ?? {})).not.toContain(
      rotated.telemetryKey,
    );
  });

  it("accepts notifyAppReady only with the current telemetry key", async () => {
    const telemetry = createFirebaseTelemetryOperations(firestore);
    const issued = await telemetry.issueTelemetryKey();

    const accepted = await createNotifyAppReadyResult({
      operations: telemetry,
      request: createNotifyRequest(issued.telemetryKey),
    });

    expect(accepted).toEqual({
      body: { accepted: true, deduped: false },
      status: 202,
    });

    const rotated = await telemetry.rotateTelemetryKey();
    const stale = await createNotifyAppReadyResult({
      operations: telemetry,
      request: createNotifyRequest(issued.telemetryKey),
    });
    const current = await createNotifyAppReadyResult({
      operations: telemetry,
      request: createNotifyRequest(rotated.telemetryKey),
    });

    expect(stale.status).toBe(401);
    expect(current.status).toBe(202);
  });

  it("mounts POST /api/notify-app-ready for Firebase Functions runtime", async () => {
    const telemetry = createFirebaseTelemetryOperations(firestore);
    const app = createFirebaseTelemetryApp(telemetry);
    const issued = await telemetry.issueTelemetryKey();

    const response = await app.fetch(createNotifyRequest(issued.telemetryKey));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      deduped: false,
    });
  });

  it("rejects malformed telemetry keys and credential channels", async () => {
    const telemetry = createFirebaseTelemetryOperations(firestore);
    const issued = await telemetry.issueTelemetryKey();
    const randomKey = `hutk_${randomUUID().replaceAll("-", "")}`;

    const attempts = [
      createNotifyRequest("hutk_"),
      createNotifyRequest("wrong_prefix"),
      createNotifyRequest(randomKey),
      createNotifyRequest(issued.telemetryKey, undefined, {
        headers: { authorization: `Bearer ${issued.telemetryKey}` },
      }),
      createNotifyRequest(issued.telemetryKey, undefined, {
        headers: { cookie: `telemetry=${issued.telemetryKey}` },
      }),
      createNotifyRequest(issued.telemetryKey, undefined, {
        query: `?x-hot-updater-telemetry-key=${encodeURIComponent(
          issued.telemetryKey,
        )}`,
      }),
    ];

    for (const request of attempts) {
      const result = await createNotifyAppReadyResult({
        operations: telemetry,
        request,
      });

      expect(result.status).toBe(401);
    }
  });

  it("records ACTIVE and RECOVERED lifecycle metrics for console bundle metrics", async () => {
    const telemetry = createFirebaseTelemetryOperations(firestore);
    const issued = await telemetry.issueTelemetryKey();
    const bundleId = `bundle-${randomUUID()}`;

    await createNotifyAppReadyResult({
      operations: telemetry,
      request: createNotifyRequest(
        issued.telemetryKey,
        createLifecyclePayload({ bundleId, status: "ACTIVE" }),
      ),
    });
    await createNotifyAppReadyResult({
      operations: telemetry,
      request: createNotifyRequest(
        issued.telemetryKey,
        createLifecyclePayload({
          bundleId,
          crashedBundleId: `crashed-${randomUUID()}`,
          status: "RECOVERED",
        }),
      ),
    });

    const rejectedRecovered = await createNotifyAppReadyResult({
      operations: telemetry,
      request: createNotifyRequest(
        issued.telemetryKey,
        createLifecyclePayload({ bundleId, status: "RECOVERED" }),
      ),
    });
    const metrics = await telemetry.readLifecycleMetrics();

    expect(rejectedRecovered.status).toBe(400);
    expect(metrics.totals).toEqual({ active: 1, recovered: 1 });
    expect(metrics.bundles).toEqual([
      {
        active: 1,
        bundleId,
        channel: "production",
        lastSeenAt: "2026-06-29T00:00:00.000Z",
        platform: "ios",
        recovered: 1,
      },
    ]);
    expect(metrics.series).toEqual([
      {
        active: 1,
        bucketStart: "2026-06-29T00:00:00.000Z",
        bundleId,
        recovered: 1,
      },
    ]);
  });
});
