import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { lynx } from "../../packages/lynx/dist/build.mjs";
import { s3Storage } from "../../plugins/aws/dist/index.mjs";
import {
  createStorageDownloadUrl,
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
} from "../../plugins/plugin-core/dist/index.mjs";
import { standaloneRepository } from "../../plugins/standalone/dist/index.mjs";

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

function localFsStorage(options: {
  readonly directory: string;
  readonly signingKey: string;
}) {
  const objectPath = (key: string) => path.join(options.directory, key);
  return createStoragePlugin({
    name: "local-fs",
    protocol: "storage",
    async put({ key, body, contentType }) {
      const storageUri = createStorageUri({
        bucket: "my-app",
        key,
        protocol: "storage",
      });
      const file = objectPath(key);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      await fsp.writeFile(file, bytes);
      await fsp.writeFile(
        `${file}.meta.json`,
        JSON.stringify({ contentType, storageUri }),
      );
      return { storageUri };
    },
    async get({ storageUri }) {
      const parsed = parseStorageUri(storageUri, "storage");
      try {
        const body = await fsp.readFile(objectPath(parsed.key));
        return { response: new Response(body) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { response: null };
        }
        throw error;
      }
    },
    getDownloadUrl: createStorageDownloadUrl(options.signingKey),
    async exists({ storageUri }) {
      const parsed = parseStorageUri(storageUri, "storage");
      try {
        await fsp.access(objectPath(parsed.key));
        return { exists: true };
      } catch {
        return { exists: false };
      }
    },
    async delete({ storageUri }) {
      const parsed = parseStorageUri(storageUri, "storage");
      await fsp.rm(objectPath(parsed.key), { force: true });
      return { deleted: true };
    },
  });
}

function resolveStorage() {
  if (process.env.AWS_S3_ENDPOINT) {
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
  const directory = process.env.HOT_UPDATER_STORAGE_DIR;
  const signingKey = process.env.HOT_UPDATER_STORAGE_DOWNLOAD_URL_KEY;
  if (!directory || !signingKey) {
    throw new Error(
      "Lynx deploy needs AWS_S3_ENDPOINT or HOT_UPDATER_STORAGE_DIR",
    );
  }
  return localFsStorage({ directory, signingKey });
}

const runtimeId = (platform: "ios" | "android") =>
  platform === "ios"
    ? "sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-v2"
    : "android-sparkling-2.1.0-rc.12-lynx-3.9.0-primjs-3.8.0-alpha.6-ota-v2";

function rewriteAndroidEmulatorUrl(
  url: string,
  env: NodeJS.ProcessEnv,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    return url;
  }
  parsed.hostname = "10.0.2.2";
  const devicePort = env.HOT_UPDATER_E2E_ANDROID_CONTROL_DEVICE_PORT ?? "3107";
  const hostPort = env.HOT_UPDATER_E2E_CONTROL_PORT ?? env.PORT ?? "";
  if (hostPort && parsed.port === devicePort) {
    parsed.port = hostPort;
  }
  return parsed.toString();
}

async function copyE2eFixtures(cwd: string, outDir: string) {
  const srcDir = path.join(cwd, "src/test");
  let names: string[];
  try {
    names = await fsp.readdir(srcDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const destDir = path.join(outDir, "assets/src/test");
  const androidRawDir = path.join(outDir, "raw");
  await fsp.mkdir(destDir, { recursive: true });
  await fsp.mkdir(androidRawDir, { recursive: true });
  for (const name of names) {
    if (!name.startsWith("_fixture-")) {
      continue;
    }
    await fsp.copyFile(path.join(srcDir, name), path.join(destDir, name));
    await fsp.copyFile(
      path.join(srcDir, name),
      path.join(androidRawDir, `src_test_${name.replaceAll("-", "")}`),
    );
  }
}

export default {
  updateStrategy: "appVersion",
  fingerprint: {
    debug: true,
  },
  compressStrategy: "zip",
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
        HOT_UPDATER_E2E_BUILD_ID: bundleId,
      };
      if (platform === "android") {
        for (const key of [
          "HOT_UPDATER_E2E_RUNTIME_CONFIG_URL",
          "HOT_UPDATER_E2E_APP_BASE_URL",
          "HOT_UPDATER_APP_BASE_URL",
        ] as const) {
          if (compileEnv[key]) {
            compileEnv[key] = rewriteAndroidEmulatorUrl(
              compileEnv[key],
              compileEnv,
            );
          }
        }
      }
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
      await copyE2eFixtures(cwd, outDir);
      return {
        entry: "main.lynx.bundle",
        runtimeId: runtimeId(platform),
      };
    },
  }),
  storage: resolveStorage(),
  database: standaloneRepository({
    baseUrl: adminBaseUrl,
    ...(adminHeaders ? { commonHeaders: adminHeaders } : {}),
  }),
};
