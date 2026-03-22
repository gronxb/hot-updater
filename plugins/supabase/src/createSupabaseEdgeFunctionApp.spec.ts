import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { mockDatabase, mockStorage } from "@hot-updater/mock";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";
import { createHotUpdater } from "../../../packages/server/src/db";
import {
  createSupabaseEdgeFunctionApp,
  HOT_UPDATER_BASE_PATH,
} from "./createSupabaseEdgeFunctionApp";

const FUNCTION_BASE_PATH = "/hot-updater-function";

const createTestHotUpdater = () =>
  createHotUpdater({
    database: mockDatabase({
      latency: { min: 0, max: 0 },
    }),
    storages: [mockStorage({})],
    basePath: HOT_UPDATER_BASE_PATH,
    routes: {
      updateCheck: true,
      bundles: false,
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
    return `${FUNCTION_BASE_PATH}${HOT_UPDATER_BASE_PATH}/app-version/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.appVersion)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
  }

  return `${FUNCTION_BASE_PATH}${HOT_UPDATER_BASE_PATH}/fingerprint/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.fingerprintHash)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
};

describe("supabase edge function runtime integration", () => {
  let currentHotUpdater = createTestHotUpdater();

  const app = createSupabaseEdgeFunctionApp({
    functionBasePath: FUNCTION_BASE_PATH,
    getHotUpdater: () => currentHotUpdater,
  });

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    currentHotUpdater = createTestHotUpdater();
    await seedBundles(currentHotUpdater, bundles);

    const response = await app.fetch(
      new Request(
        `https://example.com${FUNCTION_BASE_PATH}${HOT_UPDATER_BASE_PATH}`,
        {
          headers: createLegacyHeaders(args),
        },
      ),
    );

    return (await response.json()) as any;
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

  it("serves canonical routes from the function base path", async () => {
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

    const response = await app.fetch(
      new Request(
        `https://example.com${createCanonicalPath({
          appVersion: "1.0",
          bundleId: NIL_UUID,
          platform: "ios",
          _updateStrategy: "appVersion",
        })}`,
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
  });

  it("returns rewrite validation errors on the exact path", async () => {
    currentHotUpdater = createTestHotUpdater();

    const response = await app.fetch(
      new Request(
        `https://example.com${FUNCTION_BASE_PATH}${HOT_UPDATER_BASE_PATH}`,
        {
          headers: {
            "x-app-platform": "ios",
            "x-app-version": "1.0.0",
          },
        },
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing required headers (x-app-platform, x-bundle-id).",
    });
  });

  it("does not expose management routes from the function base path", async () => {
    currentHotUpdater = createTestHotUpdater();

    const response = await app.fetch(
      new Request(
        `https://example.com${FUNCTION_BASE_PATH}${HOT_UPDATER_BASE_PATH}/api/bundles`,
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });
});
