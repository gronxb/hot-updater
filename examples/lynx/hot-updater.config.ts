import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { s3Storage } from "@hot-updater/aws";
import { lynx } from "@hot-updater/lynx-build";
import { standaloneRepository } from "@hot-updater/standalone";

import { writeLynxBackgroundEntry } from "../../e2e/lynx/background-entry.ts";
import { LYNX_E2E_BUILTIN_BUNDLE_ID } from "../../e2e/lynx/embedded-bundle.ts";
import { copyE2eFixtures } from "./scripts/copy-e2e-fixtures";
import { resolveE2eBuildRuntimeId } from "./src/e2eBuildRuntimeId";

const run = promisify(execFile);

const envPath =
  process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater";
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;
const adminBaseUrl =
  process.env.HOT_UPDATER_STANDALONE_BASE_URL ??
  `${process.env.HOT_UPDATER_APP_BASE_URL ?? "http://127.0.0.1:3007/hot-updater"}/admin`;
const adminHeaders = adminToken
  ? { authorization: `Bearer ${adminToken}` }
  : undefined;

function resolveStorage() {
  return s3Storage({
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.AWS_S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.AWS_S3_METADATA_BUCKET!,
    basePath: process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE,
    forcePathStyle: true,
  });
}

export default {
  updateStrategy: "appVersion",
  platform: {
    ios: {
      infoPlistPaths: [
        "ios/Info.plist",
        "ios/MatrixHarness/NonProductionInfo.plist",
      ],
    },
  },
  fingerprint: {
    debug: true,
    ignorePaths: [
      "android/.probe-results/**",
      "android/e2e-app/**",
      "android/local.properties",
      "android/matrix-app/**",
      "android/scripts/**",
      "ios/.fixtures/**",
      "ios/.g1-preserved/**",
      "ios/.g2-preserved/**",
      "ios/.probe-results/**",
      "ios/.public-v1-preserved/**",
      "ios/.upstream/**",
      "ios/Embedded/**",
      "ios/MatrixHarness/**",
      "ios/ProductionEmbedded/**",
      "ios/SparklingGo.xcodeproj/project.xcworkspace/**",
      "ios/SparklingGo.xcodeproj/xcshareddata/xcschemes/SparklingGoE2E.xcscheme",
      "ios/SparklingGo.xcodeproj/xcshareddata/xcschemes/SparklingMatrixHarness.xcscheme",
      "ios/generated/**",
    ],
  },
  signing: {
    enabled: true,
    privateKeyPath: "./keys/private-key.pem",
  },
  /* E2E_AUTO_PATCH_CONFIG_START */
  patch: {
    enabled: false,
    maxBaseBundles: 2,
  },
  /* E2E_AUTO_PATCH_CONFIG_END */
  build: lynx({
    getBundleSigningPublicKey: async ({ cwd }) => ({
      publicKey: await fsp.readFile(
        path.join(cwd, "keys/public-key.pem"),
        "utf8",
      ),
    }),
    build: async ({ cwd, outDir, platform, bundleId }) => {
      const selectedRuntimeId = resolveE2eBuildRuntimeId(platform);
      for (const cacheDir of [
        ".rspeedy",
        "node_modules/.cache",
        "node_modules/.rspack",
      ]) {
        await fsp.rm(path.join(cwd, cacheDir), {
          recursive: true,
          force: true,
        });
      }
      const compileEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOT_UPDATER_BUILD_DIR: outDir,
      };
      await run(
        "pnpm",
        [
          "exec",
          "rspeedy",
          "build",
          "--config",
          "e2e.lynx.config.ts",
          "--environment",
          "lynx",
        ],
        {
          cwd,
          env: compileEnv,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const { finishLynxE2eBundle } = await import("./scripts/e2e-assets.mjs");
      const { pageEntries, pageEssentialResources } =
        await finishLynxE2eBundle(outDir);
      await copyE2eFixtures(cwd, outDir);
      const patchSurface = await fsp.readFile(
        path.join(cwd, "src/e2eApp/patchSurface.ts"),
        "utf8",
      );
      const scenarioMarker =
        /export const E2E_SCENARIO_MARKER = "([^"]+)";/.exec(patchSurface)?.[1];
      const reuseEmbeddedIdentity =
        process.env.HOT_UPDATER_E2E_BUILD_MODE !== "cross-provenance" &&
        scenarioMarker === "targeted-qa-detox";
      if (!scenarioMarker)
        throw new Error("Missing deployed Lynx scenario marker");
      const effectiveBundleId = reuseEmbeddedIdentity
        ? LYNX_E2E_BUILTIN_BUNDLE_ID
        : bundleId;
      const backgroundEntry = await writeLynxBackgroundEntry(outDir, {
        bundleId: effectiveBundleId,
        marker: scenarioMarker,
      });
      return {
        entry: "main.lynx.bundle",
        backgroundEntry,
        pageEntries,
        pageEssentialResources,
        runtimeId: selectedRuntimeId,
        bundleId: effectiveBundleId,
      };
    },
  }),
  storage: resolveStorage(),
  database: standaloneRepository({
    baseUrl: adminBaseUrl,
    ...(adminHeaders ? { commonHeaders: adminHeaders } : {}),
  }),
};
