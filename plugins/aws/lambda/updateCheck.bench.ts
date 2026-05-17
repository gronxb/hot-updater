import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { createBlobDatabasePlugin } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server/runtime";
import { bench, describe } from "vitest";

const BASE_PATH = "/api/check-update";
const APP_VERSION = "1.0.0";
const TARGET_FINGERPRINT = "fingerprint-target";
const CHANNELS = ["production", "staging"] as const;
const PLATFORMS = ["ios", "android"] as const;
const APP_VERSION_BUCKETS_PER_ROUTE = 180;
const FINGERPRINT_BUCKETS_PER_ROUTE = 320;
const BUNDLES_PER_APP_VERSION = 3;
const BUNDLES_PER_FINGERPRINT = 2;

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

const createBenchHotUpdater = () => {
  const store = createDatasetStore();
  const keys = Object.keys(store);

  const database = createBlobDatabasePlugin({
    name: "lambdaBenchDatabase",
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
        name: "lambdaBenchStorage",
        supportedProtocol: "s3",
        profiles: {
          runtime: {
            async readText() {
              return null;
            },
            async getDownloadUrl(storageUri) {
              const url = new URL("https://assets.example.com");
              url.pathname = new URL(storageUri).pathname;
              return {
                fileUrl: url.toString(),
              };
            },
          },
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

const hotUpdater = createBenchHotUpdater();
const appVersionUrl = `https://updates.example.com${BASE_PATH}/app-version/ios/${APP_VERSION}/production/${NIL_UUID}/${NIL_UUID}`;
const fingerprintUrl = `https://updates.example.com${BASE_PATH}/fingerprint/ios/${TARGET_FINGERPRINT}/production/${NIL_UUID}/${NIL_UUID}`;

describe("aws lambda update check benchmark", () => {
  bench("lambda app-version route", async () => {
    const response = await hotUpdater.handler(new Request(appVersionUrl));
    if (response.status !== 200) {
      throw new Error(`Expected 200 response, received ${response.status}.`);
    }
    await response.text();
  });

  bench("lambda fingerprint route", async () => {
    const response = await hotUpdater.handler(new Request(fingerprintUrl));
    if (response.status !== 200) {
      throw new Error(`Expected 200 response, received ${response.status}.`);
    }
    await response.text();
  });
});
