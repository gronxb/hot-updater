import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { mockDatabase, mockStorage } from "@hot-updater/mock";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";
import { createHotUpdater } from "../../../packages/server/src/db";
import {
  NO_STORE_CACHE_CONTROL,
  SHARED_EDGE_CACHE_CONTROL,
} from "./cacheControl";
import { createAwsLambdaEdgeHandler, HOT_UPDATER_BASE_PATH } from "./runtime";

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

const toCloudFrontHeaders = (headers: Headers) => {
  const cloudFrontHeaders: Record<string, { key: string; value: string }[]> =
    {};

  for (const [key, value] of headers.entries()) {
    cloudFrontHeaders[key.toLowerCase()] = [{ key: key.toLowerCase(), value }];
  }

  return cloudFrontHeaders;
};

const createCloudFrontEvent = ({
  method = "GET",
  path,
  headers = new Headers(),
}: {
  method?: string;
  path: string;
  headers?: Headers;
}) =>
  ({
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: "updates.example.com",
            distributionId: "dist-id",
            eventType: "viewer-request",
            requestId: "request-id",
          },
          request: {
            clientIp: "127.0.0.1",
            headers: toCloudFrontHeaders(headers),
            method,
            querystring: "",
            uri: path,
          },
        },
      },
    ],
  }) as any;

const readLambdaJson = async (result: {
  body?: string;
  headers?: Record<string, { key: string; value: string }[]>;
}) => {
  if (!result.body) {
    return null;
  }

  return JSON.parse(result.body) as Record<string, unknown> | null;
};

describe("aws lambda-edge runtime integration", () => {
  let currentHotUpdater = createTestHotUpdater();

  const handler = createAwsLambdaEdgeHandler({
    getHotUpdater: () => currentHotUpdater,
  });

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    currentHotUpdater = createTestHotUpdater();
    await seedBundles(currentHotUpdater, bundles);

    const result = (await handler(
      createCloudFrontEvent({
        path: HOT_UPDATER_BASE_PATH,
        headers: createLegacyHeaders(args),
      }),
      {} as never,
      undefined as never,
    )) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
    };

    return readLambdaJson(result) as Promise<any>;
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

  it("keeps canonical routes uncoupled from legacy rewrite and applies edge cache", async () => {
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

    const result = (await handler(
      createCloudFrontEvent({
        path: createCanonicalPath({
          appVersion: "1.0",
          bundleId: NIL_UUID,
          platform: "ios",
          _updateStrategy: "appVersion",
        }),
      }),
      {} as never,
      undefined as never,
    )) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
    };

    expect(result.headers?.["cache-control"]?.[0]?.value).toBe(
      SHARED_EDGE_CACHE_CONTROL,
    );
    await expect(readLambdaJson(result)).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
  });

  it("marks legacy exact responses as non-cacheable", async () => {
    currentHotUpdater = createTestHotUpdater();

    const result = (await handler(
      createCloudFrontEvent({
        path: HOT_UPDATER_BASE_PATH,
        headers: new Headers({
          "x-app-platform": "ios",
          "x-app-version": "1.0.0",
        }),
      }),
      {} as never,
      undefined as never,
    )) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
    };

    expect(result.headers?.["cache-control"]?.[0]?.value).toBe(
      NO_STORE_CACHE_CONTROL,
    );
    await expect(readLambdaJson(result)).resolves.toEqual({
      error: "Missing required headers (x-app-platform, x-bundle-id).",
    });
  });

  it("does not expose management routes", async () => {
    currentHotUpdater = createTestHotUpdater();

    const result = (await handler(
      createCloudFrontEvent({
        path: `${HOT_UPDATER_BASE_PATH}/api/bundles`,
      }),
      {} as never,
      undefined as never,
    )) as {
      body?: string;
    };

    await expect(readLambdaJson(result)).resolves.toEqual({
      error: "Not found",
    });
  });
});
