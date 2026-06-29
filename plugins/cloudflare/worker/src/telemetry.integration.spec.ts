import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import {
  getCloudflareLifecycleMetrics,
  issueCloudflareTelemetryKey,
  rotateCloudflareTelemetryKey,
} from "../../src/cloudflareTelemetry";
import preparedTelemetrySql from "../../sql/telemetry.sql?raw";
import worker from "./index";
import telemetryMigration from "../migrations/0006_hot-updater_telemetry.sql?raw";

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    BUCKET: R2Bucket;
    JWT_SECRET: string;
  }
}

const PUBLIC_BASE_URL = "https://updates.example.com";

type JsonObject = Readonly<Record<string, unknown>>;

const notifyPayload = {
  bundleId: "bundle-active",
  channel: "production",
  eventId: "event-active",
  installId: "install-active",
  platform: "ios",
  status: "ACTIVE",
} as const;

const recoveredPayload = {
  bundleId: "bundle-recovered",
  channel: "production",
  crashedBundleId: "bundle-active",
  eventId: "event-recovered",
  installId: "install-recovered",
  platform: "ios",
  status: "RECOVERED",
} as const;

const readJsonObject = async (response: Response): Promise<JsonObject> => {
  const value = await response.json();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  throw new TypeError("Expected JSON object response");
};

const postNotifyAppReady = (
  telemetryKey: string | null,
  payload: JsonObject = notifyPayload,
  init?: RequestInit,
) => {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (telemetryKey !== null) {
    headers.set("x-hot-updater-telemetry-key", telemetryKey);
  }

  return worker.fetch(
    new Request(`${PUBLIC_BASE_URL}/api/notify-app-ready`, {
      ...init,
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }),
    env,
  );
};

describe.sequential("cloudflare telemetry runtime", () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bundle_lifecycle_events").run();
    await env.DB.prepare("DELETE FROM bundle_install_state").run();
    await env.DB.prepare("DELETE FROM telemetry_keys").run();
  });

  it("accepts notifyAppReady with a freshly issued telemetry key", async () => {
    const issued = await issueCloudflareTelemetryKey(env.DB);

    const response = await postNotifyAppReady(issued.telemetryKey);

    expect(response.status).toBe(202);
    await expect(readJsonObject(response)).resolves.toEqual({
      accepted: true,
      deduped: false,
    });
    expect(issued.telemetryKey).toMatch(/^hutk_.+/);
    expect(issued.telemetryKey.endsWith(issued.telemetryKeySuffix)).toBe(true);
  });

  it("rejects the old telemetry key after rotation", async () => {
    const issued = await issueCloudflareTelemetryKey(env.DB);
    const rotated = await rotateCloudflareTelemetryKey(env.DB);

    const staleResponse = await postNotifyAppReady(issued.telemetryKey);
    const currentResponse = await postNotifyAppReady(rotated.telemetryKey, {
      ...notifyPayload,
      eventId: "event-rotated",
    });

    expect(staleResponse.status).toBe(401);
    expect(currentResponse.status).toBe(202);
  });

  it("rejects missing, wrong-prefix, random, and bare-prefix telemetry keys", async () => {
    await issueCloudflareTelemetryKey(env.DB);

    const cases = [
      null,
      "huc_deploy_key_12345678",
      "hutk_random_12345678",
      "hutk_",
    ] as const;

    for (const telemetryKey of cases) {
      const response = await postNotifyAppReady(telemetryKey);

      expect(response.status).toBe(401);
    }
  });

  it("rejects authorization, cookie, and query-string telemetry credentials", async () => {
    const issued = await issueCloudflareTelemetryKey(env.DB);

    const authorizationResponse = await postNotifyAppReady(null, notifyPayload, {
      headers: {
        authorization: `Bearer ${issued.telemetryKey}`,
      },
    });
    const cookieResponse = await postNotifyAppReady(null, notifyPayload, {
      headers: {
        cookie: `telemetryKey=${issued.telemetryKey}`,
      },
    });
    const queryResponse = await worker.fetch(
      new Request(
        `${PUBLIC_BASE_URL}/api/notify-app-ready?telemetryKey=${encodeURIComponent(issued.telemetryKey)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(notifyPayload),
        },
      ),
      env,
    );

    expect(authorizationResponse.status).toBe(401);
    expect(cookieResponse.status).toBe(401);
    expect(queryResponse.status).toBe(401);
  });

  it("surfaces ACTIVE and RECOVERED counts through provider metrics", async () => {
    const issued = await issueCloudflareTelemetryKey(env.DB);

    const activeResponse = await postNotifyAppReady(issued.telemetryKey);
    const recoveredResponse = await postNotifyAppReady(
      issued.telemetryKey,
      recoveredPayload,
    );
    const metrics = await getCloudflareLifecycleMetrics(env.DB);

    expect(activeResponse.status).toBe(202);
    expect(recoveredResponse.status).toBe(202);
    expect(metrics.totals).toEqual({ active: 2, recovered: 1 });
    expect(metrics.bundles).toEqual([
      {
        active: 1,
        bundleId: "bundle-active",
        channel: "production",
        lastSeenAt: expect.any(String),
        platform: "ios",
        recovered: 1,
      },
      {
        active: 1,
        bundleId: "bundle-recovered",
        channel: "production",
        lastSeenAt: expect.any(String),
        platform: "ios",
        recovered: 0,
      },
    ]);
  });

  it("dedupes concurrent notifyAppReady requests with the same eventId", async () => {
    const issued = await issueCloudflareTelemetryKey(env.DB);

    const responses = await Promise.all([
      postNotifyAppReady(issued.telemetryKey),
      postNotifyAppReady(issued.telemetryKey),
    ]);
    const bodies = await Promise.all(responses.map(readJsonObject));
    const metrics = await getCloudflareLifecycleMetrics(env.DB);
    const lifecycleEventCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bundle_lifecycle_events",
    ).first<{ readonly count: number }>();
    const installState = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM bundle_install_state",
    ).first<{ readonly count: number }>();

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { accepted: true, deduped: false },
        { accepted: true, deduped: true },
      ]),
    );
    expect(lifecycleEventCount).toEqual({ count: 1 });
    expect(installState).toEqual({ count: 1 });
    expect(metrics.totals).toEqual({ active: 1, recovered: 0 });
  });

  it("stores telemetry key hash and suffix only in D1 schema", () => {
    for (const source of [telemetryMigration, preparedTelemetrySql]) {
      expect(source).toContain("key_hash");
      expect(source).toContain("key_suffix");
      expect(source).not.toMatch(/\btelemetry_key\s+TEXT\b/i);
      expect(source).not.toMatch(/\bkey\s+TEXT\b/i);
      expect(source).not.toMatch(/plain|secret|token/i);
    }
  });
});
