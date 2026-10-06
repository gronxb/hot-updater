import path from "node:path";

import { lynxMobileEnvironment, type MobileRuntime } from "../mobile/target.ts";

export type LocalPlatform = "ios" | "android";

export interface LocalProfile {
  root: string;
  platform: LocalPlatform;
  runtime: MobileRuntime;
  runDir: string;
  appDir: string;
  serverDir: string;
  containerName: string;
  providerPort: number;
  controlPort: number;
  storagePort: number;
  env: NodeJS.ProcessEnv;
}

export function createLocalProfile(options: {
  root: string;
  platform: LocalPlatform;
  runtime?: MobileRuntime;
  runDir: string;
  id: string;
  providerPort: number;
  controlPort: number;
  storagePort: number;
  token: string;
  storagePassword: string;
  signingKey: string;
  env: NodeJS.ProcessEnv;
}): LocalProfile {
  const runtime = options.runtime ?? "react-native";
  const appDir = path.join(
    options.root,
    runtime === "lynx" ? "examples/lynx" : "examples/v0.85.0",
  );
  const providerUrl = `http://127.0.0.1:${options.providerPort}/hot-updater`;
  const runtimePort =
    options.platform === "android" ? 3107 : options.controlPort;
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    NODE_ENV: "production",
    BABEL_ENV: "production",
    HOT_UPDATER_E2E_LOCAL_PROVIDER: "1",
    PORT: String(options.providerPort),
    TEST_DB_PATH: path.join(options.runDir, "database"),
    HOT_UPDATER_ADMIN_TOKEN: options.token,
    HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY: options.signingKey,
    HOT_UPDATER_APP_BASE_URL: providerUrl,
    HOT_UPDATER_CONTROL_BASE_URL: providerUrl,
    HOT_UPDATER_E2E_APP_BASE_URL: providerUrl,
    HOT_UPDATER_SERVER_PORT: String(options.providerPort),
    HOT_UPDATER_E2E_CONTROL_PORT: String(options.controlPort),
    HOT_UPDATER_E2E_SERVER_HOST: "127.0.0.1",
    HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT: "3107",
    HOT_UPDATER_E2E_ANDROID_REVERSE_HOST_PORT: String(options.providerPort),
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL: `http://127.0.0.1:${runtimePort}/e2e/runtime-config`,
    HOT_UPDATER_E2E_ENV_TARGET_PATH: path.join(appDir, ".env.hotupdater"),
    HOT_UPDATER_E2E_ENV_TARGET_DIR: appDir,
    HOT_UPDATER_E2E_PROVIDER_NAMESPACE: `local/${options.id}`,
    HOT_UPDATER_E2E_CHANNEL_NAMESPACE: `local-${options.id}`,
    HOT_UPDATER_E2E_IOS_DERIVED_DATA_PATH: path.join(options.runDir, "ios"),
    AWS_REGION: "us-east-1",
    AWS_S3_ENDPOINT: `http://127.0.0.1:${options.storagePort}`,
    AWS_S3_METADATA_BUCKET: `hot-updater-${options.id}`,
    AWS_ACCESS_KEY_ID: "hot-updater-local",
    AWS_SECRET_ACCESS_KEY: options.storagePassword,
  };
  // The local server uses public client access, and owns its control server.
  for (const key of [
    "HOT_UPDATER_API_KEY",
    "HOT_UPDATER_E2E_APP_ID",
    "HOT_UPDATER_E2E_IOS_APP_ID",
    "HOT_UPDATER_STANDALONE_BASE_URL",
    "CONTROL_URL",
    "HOT_UPDATER_E2E_CONTROL_BASE_URL",
    "HOT_UPDATER_E2E_IOS_BINARY_PATH",
    "HOT_UPDATER_E2E_ANDROID_BINARY_PATH",
    "HOT_UPDATER_E2E_ANDROID_APK_PATH",
  ])
    delete env[key];
  return {
    root: options.root,
    platform: options.platform,
    runtime,
    runDir: options.runDir,
    appDir,
    serverDir: path.join(options.root, "examples-server/hono-kysely-pglite"),
    containerName: `hot-updater-e2e-${options.id}`,
    providerPort: options.providerPort,
    controlPort: options.controlPort,
    storagePort: options.storagePort,
    env: runtime === "lynx" ? lynxMobileEnvironment(options.root, env) : env,
  };
}

export function localAppConfig(strategy: "appVersion" | "fingerprint"): string {
  return `import { s3Storage } from "@hot-updater/aws";
import { bare } from "@hot-updater/bare";
import { insights } from "@hot-updater/server/plugins/insights";
import { standaloneRepository } from "@hot-updater/standalone";
import { defineConfig } from "hot-updater";

process.loadEnvFile(process.env.HOT_UPDATER_E2E_ENV_TARGET_PATH ?? ".env.hotupdater");

export default defineConfig({
  build: bare({ enableHermes: true, resetCache: false }),
  storage: s3Storage({
    region: process.env.AWS_REGION!,
    endpoint: process.env.AWS_S3_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    bucketName: process.env.AWS_S3_METADATA_BUCKET!,
    basePath: process.env.HOT_UPDATER_E2E_PROVIDER_NAMESPACE,
    forcePathStyle: true,
  }),
  database: standaloneRepository({
    baseUrl: process.env.HOT_UPDATER_CONTROL_BASE_URL! + "/admin",
    commonHeaders: { Authorization: "Bearer " + process.env.HOT_UPDATER_ADMIN_TOKEN! },
  }),
  plugins: [insights()],
  fingerprint: { debug: true },
  /* E2E_AUTO_PATCH_CONFIG_START */
  patch: { enabled: true, maxBaseBundles: 2 },
  /* E2E_AUTO_PATCH_CONFIG_END */
  updateStrategy: "${strategy}",
  signing: { enabled: true, privateKeyPath: "./keys/private-key.pem" },
});
`;
}

export function localEnvFile(env: NodeJS.ProcessEnv): string {
  const keys = [
    "HOT_UPDATER_ADMIN_TOKEN",
    "HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY",
    "HOT_UPDATER_APP_BASE_URL",
    "HOT_UPDATER_CONTROL_BASE_URL",
    "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
    "HOT_UPDATER_E2E_PROVIDER_NAMESPACE",
    "AWS_REGION",
    "AWS_S3_ENDPOINT",
    "AWS_S3_METADATA_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ];
  return (
    keys.map((key) => `${key}=${JSON.stringify(env[key])}`).join("\n") + "\n"
  );
}

export function siloImage(compose: string): string {
  const image = /\n  minio:\n    image: ([^\s]+)/.exec(compose)?.[1];
  if (!image || !/^pgsty\/silo:RELEASE\.[A-Za-z0-9._-]+$/.test(image)) {
    throw new Error("The checked-in local S3 service has no pinned Silo image");
  }
  return image;
}

export function selectDevice(
  platform: LocalPlatform,
  output: string,
  requested?: string,
): string {
  const devices =
    platform === "ios"
      ? Object.values(
          (
            JSON.parse(output) as {
              devices: Record<
                string,
                Array<{
                  udid: string;
                  name: string;
                  state: string;
                  isAvailable?: boolean;
                }>
              >;
            }
          ).devices,
        )
          .flat()
          .filter((device) => device.isAvailable !== false)
          .map((device) => ({
            id: device.udid,
            ready: device.state === "Booted",
          }))
      : output.split(/\r?\n/).flatMap((line) => {
          const match = /^(emulator-\d+)\s+device(?:\s|$)/.exec(line);
          return match ? [{ id: match[1]!, ready: true }] : [];
        });
  if (requested && devices.some((device) => device.id === requested))
    return requested;
  const ready = devices.filter((device) => device.ready);
  if (!requested && ready.length === 1) return ready[0]!.id;
  throw new Error(
    [
      requested
        ? `Device ${requested} is unavailable.`
        : `Select one ${platform} device with --device.`,
      `Available IDs: ${devices.map((device) => device.id).join(", ") || "none"}.`,
      platform === "ios"
        ? "List simulators: xcrun simctl list devices available"
        : "Start an emulator, then run: adb devices",
    ].join(" "),
  );
}
