import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { mockDatabase, mockStorage } from "@hot-updater/mock";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";
import { createHotUpdater } from "../../../../packages/server/src/db";
import {
  createFirebaseFunctionsHandler,
  HOT_UPDATER_BASE_PATH,
} from "./runtime";

const createTestHotUpdater = () =>
  createHotUpdater({
    database: mockDatabase({
      latency: { min: 0, max: 0 },
    }),
    storages: [mockStorage({})],
    basePath: HOT_UPDATER_BASE_PATH,
    features: {
      updateCheckOnly: true,
    },
  });

const seedBundles = async (
  hotUpdater: ReturnType<typeof createTestHotUpdater>,
  bundles: Bundle[],
) => {
  for (const bundle of bundles) {
    await hotUpdater.insertBundle(bundle);
  }
};

const createLegacyHeaders = (args: GetBundlesArgs) => {
  const headers = new Headers({
    "x-app-platform": args.platform,
    "x-bundle-id": args.bundleId,
  });

  if (args.channel) {
    headers.set("x-channel", args.channel);
  }

  if (args.minBundleId) {
    headers.set("x-min-bundle-id", args.minBundleId);
  }

  if (args.cohort) {
    headers.set("x-cohort", args.cohort);
  }

  if (args._updateStrategy === "appVersion") {
    headers.set("x-app-version", args.appVersion);
  } else {
    headers.set("x-fingerprint-hash", args.fingerprintHash);
  }

  return headers;
};

const createCanonicalPath = (args: GetBundlesArgs) => {
  const channel = args.channel ?? "production";
  const minBundleId = args.minBundleId ?? NIL_UUID;
  const cohortSegment = args.cohort
    ? `/${encodeURIComponent(args.cohort)}`
    : "";

  if (args._updateStrategy === "appVersion") {
    return `${HOT_UPDATER_BASE_PATH}/app-version/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.appVersion)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
  }

  return `${HOT_UPDATER_BASE_PATH}/fingerprint/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.fingerprintHash)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
};

describe("firebase functions runtime integration", () => {
  let currentHotUpdater = createTestHotUpdater();
  const handler = createFirebaseFunctionsHandler({
    region: "asia-northeast3",
    getHotUpdater: () => currentHotUpdater,
  });

  const invokeHandler = async (
    path: string,
    headers?: Headers | Record<string, string>,
  ): Promise<Response> => {
    const url = new URL(path, "https://updates.example.com");
    const responseHeaders = new Headers();

    return await new Promise((resolve, reject) => {
      const req = {
        hostname: url.hostname,
        originalUrl: `${url.pathname}${url.search}`,
        url: `${url.pathname}${url.search}`,
        method: "GET",
        headers: Object.fromEntries(new Headers(headers).entries()),
      };

      const res = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        setHeader(key: string, value: string) {
          responseHeaders.set(key, value);
        },
        send(body: string) {
          resolve(
            new Response(body, {
              status: this.statusCode,
              headers: responseHeaders,
            }),
          );
          return this;
        },
      };

      Promise.resolve((handler as any)(req, res)).catch(reject);
    });
  };

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    currentHotUpdater = createTestHotUpdater();
    await seedBundles(currentHotUpdater, bundles);

    const response = await invokeHandler(
      HOT_UPDATER_BASE_PATH,
      createLegacyHeaders(args),
    );

    return (await response.json()) as any;
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

  it("serves canonical routes through the firebase wrapper", async () => {
    currentHotUpdater = createTestHotUpdater();
    await seedBundles(currentHotUpdater, [
      {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash",
        gitCommitHash: null,
        message: "hello",
        channel: "production",
        storageUri: "storage://my-app/bundle.zip",
        fingerprintHash: null,
      },
    ]);

    const response = await invokeHandler(
      createCanonicalPath({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
  });

  it("returns rewrite errors through the firebase function handler", async () => {
    currentHotUpdater = createTestHotUpdater();

    const response = await invokeHandler(HOT_UPDATER_BASE_PATH, {
      "x-app-platform": "ios",
      "x-app-version": "1.0.0",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing required headers (x-app-platform, x-bundle-id).",
    });
  });

  it("does not expose management routes", async () => {
    currentHotUpdater = createTestHotUpdater();

    const response = await invokeHandler(
      `${HOT_UPDATER_BASE_PATH}/api/bundles`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });
});
