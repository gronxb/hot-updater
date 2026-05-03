import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { createBlobDatabasePlugin } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server/runtime";
import { describe, expect, it } from "vitest";

const BASE_PATH = "/api/check-update";
const APP_VERSION = "1.0.0";
const TARGET_FINGERPRINT = "fingerprint-target";
const CHANNELS = ["production", "staging"] as const;
const PLATFORMS = ["ios", "android"] as const;
const APP_VERSION_BUCKETS_PER_ROUTE = 260;
const FINGERPRINT_BUCKETS_PER_ROUTE = 480;
const BUNDLES_PER_APP_VERSION = 4;
const BUNDLES_PER_FINGERPRINT = 2;
const REQUEST_ITERATIONS = 30;

const createBundleId = (index: number) =>
  `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;

const createStorageUri = (bundleId: string) =>
  `s3://hot-updater-bench/bundles/${bundleId}.zip`;

const createBundle = ({
  id,
  channel,
  platform,
  targetAppVersion,
  fingerprintHash,
}: {
  id: string;
  channel: string;
  platform: "ios" | "android";
  targetAppVersion: string | null;
  fingerprintHash: string | null;
}): Bundle => ({
  id,
  channel,
  enabled: true,
  fileHash: `hash-${id}`,
  fingerprintHash,
  gitCommitHash: `commit-${id}`,
  message: `bundle-${id}`,
  platform,
  shouldForceUpdate: false,
  storageUri: createStorageUri(id),
  targetAppVersion,
});

const createDatasetStore = () => {
  const store: Record<string, string> = {};
  let bundleCounter = 0;

  for (const channel of CHANNELS) {
    for (const platform of PLATFORMS) {
      const targetAppVersions: string[] = [];

      for (
        let bucketIndex = 0;
        bucketIndex < APP_VERSION_BUCKETS_PER_ROUTE;
        bucketIndex += 1
      ) {
        const targetAppVersion =
          channel === "production" &&
          platform === "ios" &&
          bucketIndex === APP_VERSION_BUCKETS_PER_ROUTE - 1
            ? APP_VERSION
            : `${platform === "ios" ? 2 : 3}.${bucketIndex}.0`;
        const bundles: Bundle[] = [];

        targetAppVersions.push(targetAppVersion);

        for (
          let bundleIndex = 0;
          bundleIndex < BUNDLES_PER_APP_VERSION;
          bundleIndex += 1
        ) {
          bundleCounter += 1;
          bundles.push(
            createBundle({
              id: createBundleId(bundleCounter),
              channel,
              platform,
              targetAppVersion,
              fingerprintHash: null,
            }),
          );
        }

        bundles.sort((left, right) => right.id.localeCompare(left.id));
        store[`${channel}/${platform}/${targetAppVersion}/update.json`] =
          JSON.stringify(bundles);
      }

      store[`${channel}/${platform}/target-app-versions.json`] =
        JSON.stringify(targetAppVersions);

      for (
        let bucketIndex = 0;
        bucketIndex < FINGERPRINT_BUCKETS_PER_ROUTE;
        bucketIndex += 1
      ) {
        const fingerprintHash =
          channel === "production" &&
          platform === "ios" &&
          bucketIndex === FINGERPRINT_BUCKETS_PER_ROUTE - 1
            ? TARGET_FINGERPRINT
            : `${channel}-${platform}-fingerprint-${bucketIndex}`;
        const bundles: Bundle[] = [];

        for (
          let bundleIndex = 0;
          bundleIndex < BUNDLES_PER_FINGERPRINT;
          bundleIndex += 1
        ) {
          bundleCounter += 1;
          bundles.push(
            createBundle({
              id: createBundleId(bundleCounter),
              channel,
              platform,
              targetAppVersion: null,
              fingerprintHash,
            }),
          );
        }

        bundles.sort((left, right) => right.id.localeCompare(left.id));
        store[`${channel}/${platform}/${fingerprintHash}/update.json`] =
          JSON.stringify(bundles);
      }
    }
  }

  return store;
};

const createMemoryHotUpdater = () => {
  const store = createDatasetStore();
  const keys = Object.keys(store);

  const database = createBlobDatabasePlugin({
    name: "lambdaMemoryDatabase",
    factory: () => ({
      apiBasePath: BASE_PATH,
      listObjects: async (prefix: string) =>
        keys.filter((key) => key.startsWith(prefix)),
      loadObject: async <T>(key: string): Promise<T | null> => {
        const value = store[key];
        return value ? (JSON.parse(value) as T) : null;
      },
      uploadObject: async () => {},
      deleteObject: async () => {},
      invalidatePaths: async () => {},
    }),
  })({});

  return createHotUpdater({
    database,
    storages: [
      {
        name: "lambdaMemoryStorage",
        supportedProtocol: "s3",
        async upload() {
          throw new Error("Upload is not supported in memory benchmark mode.");
        },
        async delete() {},
        async download() {},
        async getDownloadUrl(storageUri) {
          const url = new URL("https://assets.example.com");
          url.pathname = new URL(storageUri).pathname;
          return {
            fileUrl: url.toString(),
          };
        },
      },
    ],
    basePath: BASE_PATH,
    routes: {
      updateCheck: true,
      bundles: false,
    },
  });
};

const measureScenario = async (url: string) => {
  const hotUpdater = createMemoryHotUpdater();
  const runGc = () => {
    globalThis.gc?.();
  };

  runGc();
  const initial = process.memoryUsage();
  let peakHeapUsed = initial.heapUsed;
  let peakRss = initial.rss;

  for (let iteration = 0; iteration < REQUEST_ITERATIONS; iteration += 1) {
    const response = await hotUpdater.handler(new Request(url));
    expect(response.status).toBe(200);
    await response.text();

    const snapshot = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, snapshot.heapUsed);
    peakRss = Math.max(peakRss, snapshot.rss);
  }

  runGc();
  const final = process.memoryUsage();

  return {
    finalHeapDeltaBytes: final.heapUsed - initial.heapUsed,
    finalRssDeltaBytes: final.rss - initial.rss,
    iterations: REQUEST_ITERATIONS,
    peakHeapDeltaBytes: peakHeapUsed - initial.heapUsed,
    peakRssDeltaBytes: peakRss - initial.rss,
  };
};

describe.sequential("aws lambda update check memory", () => {
  it("writes deterministic memory metrics for update-check routes", async () => {
    const outputPath =
      process.env.HOT_UPDATER_MEMORY_OUTPUT ??
      path.join(
        os.tmpdir(),
        `hot-updater-memory-${process.pid}-${Date.now()}.json`,
      );

    const appVersionUrl = `https://updates.example.com${BASE_PATH}/app-version/ios/${APP_VERSION}/production/${NIL_UUID}/${NIL_UUID}`;
    const fingerprintUrl = `https://updates.example.com${BASE_PATH}/fingerprint/ios/${TARGET_FINGERPRINT}/production/${NIL_UUID}/${NIL_UUID}`;

    const report = {
      generatedAt: new Date().toISOString(),
      scenarios: {
        appVersion: await measureScenario(appVersionUrl),
        fingerprint: await measureScenario(fingerprintUrl),
      },
    };

    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

    expect(report.scenarios.appVersion.iterations).toBe(REQUEST_ITERATIONS);
    expect(report.scenarios.fingerprint.iterations).toBe(REQUEST_ITERATIONS);
  });
});
