import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transformEnv } from "@hot-updater/cli-tools";
import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server/runtime";
import {
  setupBsdiffManifestUpdateInfoTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertDockerComposeAvailable,
  findOpenPort,
  runCheckedCommand,
  spawnRuntime,
  stopRuntime,
  waitForHttpOk,
} from "../../../../packages/test-utils/src/runtimeProcess";
import { supabaseDatabase } from "../../src/supabaseDatabase";
import { supabaseStorage } from "../../src/supabaseStorage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../..");
const FUNCTION_NAME = "hot-updater-function";
const FUNCTION_BASE_PATH = `/${FUNCTION_NAME}`;
const HOT_UPDATER_BASE_PATH = "/";
const LEGACY_HOT_UPDATER_BASE_PATH = "/api/check-update";
const BUCKET_NAME = "hot-updater-bundles";
const DENO_DOCKER_IMAGE = "denoland/deno:alpine";
const DENO_CACHE_VOLUME = "hot-updater-supabase-deno-cache";
const POSTGRES_IMAGE = "postgres:15-alpine";
const POSTGREST_IMAGE = "postgrest/postgrest:v14.6";
const STORAGE_IMAGE = "supabase/storage-api:v1.44.2";
const IMGPROXY_IMAGE = "darthsim/imgproxy:v3.30.1";
const NGINX_IMAGE = "nginx:1.27-alpine";
const POSTGRES_PASSWORD = "postgres";
const POSTGRES_DB = "postgres";
const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-chars";
const JWT_EXPIRY_SECONDS = 60 * 60 * 24 * 365;
const ANON_KEY = createLegacyJwt("anon");
const SERVICE_ROLE_KEY = createLegacyJwt("service_role");
const REQUIRED_BUILD_ARTIFACTS = [
  {
    command: "pnpm --filter @hot-updater/core build",
    path: path.join(WORKSPACE_ROOT, "packages/core/dist/index.mjs"),
  },
  {
    command: "pnpm --filter @hot-updater/server build",
    path: path.join(WORKSPACE_ROOT, "packages/server/dist/runtime.mjs"),
  },
  {
    command: "pnpm --filter @hot-updater/plugin-core build",
    path: path.join(WORKSPACE_ROOT, "plugins/plugin-core/dist/index.mjs"),
  },
  {
    command: "pnpm --filter @hot-updater/supabase build",
    path: path.join(WORKSPACE_ROOT, "plugins/supabase/dist/index.mjs"),
  },
] as const;

assertDockerComposeAvailable(
  "supabase edge runtime acceptance requires Docker Compose and a running Docker daemon.",
);

const ensureBuiltArtifacts = async (
  artifacts: ReadonlyArray<{ command: string; path: string }>,
) => {
  for (const artifact of artifacts) {
    try {
      await access(artifact.path);
    } catch {
      throw new Error(
        `Missing built artifact at ${artifact.path}. Run \`${artifact.command}\` before running this test.`,
      );
    }
  }
};

const createCanonicalPath = (args: GetBundlesArgs) => {
  const channel = args.channel ?? "production";
  const minBundleId = args.minBundleId ?? NIL_UUID;
  const cohortSegment = args.cohort
    ? `/${encodeURIComponent(args.cohort)}`
    : "";
  const joinHotUpdaterPath = (routePath: string) =>
    HOT_UPDATER_BASE_PATH === "/"
      ? routePath
      : `${HOT_UPDATER_BASE_PATH}${routePath}`;

  if (args._updateStrategy === "appVersion") {
    return joinHotUpdaterPath(
      `/app-version/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.appVersion)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`,
    );
  }

  return joinHotUpdaterPath(
    `/fingerprint/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.fingerprintHash)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`,
  );
};

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    storageUri: `supabase-storage://${BUCKET_NAME}/${bundle.id}/bundle.zip`,
  };
};

describe.sequential("supabase edge runtime acceptance", () => {
  let runtimeRoot: string | undefined;
  let storageRepoPath = "";
  let composeFilePath = "";
  let composeProjectName = "";
  let gatewayPort = 0;
  let edgePort = 0;
  let gatewayBaseUrl = "";
  let edgeRuntime: ReturnType<typeof spawnRuntime> | undefined;
  let seedHotUpdater: ReturnType<typeof createHotUpdater>;
  let supabaseAdmin: ReturnType<typeof createClient>;

  beforeAll(async () => {
    await ensureBuiltArtifacts(REQUIRED_BUILD_ARTIFACTS);

    runtimeRoot = await mkdtemp(
      path.join(WORKSPACE_ROOT, "plugins/supabase/runtime-acceptance-"),
    );
    storageRepoPath = path.join(runtimeRoot, "storage-repo");
    gatewayPort = await findOpenPort();
    edgePort = await findOpenPort();
    gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;
    composeProjectName = `hot-updater-supabase-${process.pid}-${Date.now()}`;
    composeFilePath = path.join(runtimeRoot, "docker-compose.yml");

    runCheckedCommand({
      command: "git",
      args: [
        "clone",
        "--depth",
        "1",
        "https://github.com/supabase/storage.git",
        storageRepoPath,
      ],
      cwd: WORKSPACE_ROOT,
    });

    await writeSupabaseRuntimeFiles({
      runtimeRoot,
      gatewayPort,
      storageRepoPath,
    });

    try {
      runCheckedCommand({
        command: "docker",
        args: [
          "compose",
          "-p",
          composeProjectName,
          "-f",
          composeFilePath,
          "up",
          "-d",
        ],
        cwd: WORKSPACE_ROOT,
      });
    } catch (error) {
      let dbLogs = "";

      try {
        const result = spawnSync(
          "docker",
          [
            "compose",
            "-p",
            composeProjectName,
            "-f",
            composeFilePath,
            "logs",
            "--no-color",
            "db",
          ],
          {
            cwd: WORKSPACE_ROOT,
            encoding: "utf8",
          },
        );
        dbLogs = [result.stdout, result.stderr].filter(Boolean).join("\n");
      } catch {
        dbLogs = "failed to collect database logs";
      }

      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          "",
          "Database logs:",
          dbLogs,
        ].join("\n"),
      );
    }

    await waitForUrlOk(`${gatewayBaseUrl}/storage/v1/status`);

    supabaseAdmin = createClient(gatewayBaseUrl, SERVICE_ROLE_KEY);
    await ensureBucketExists(supabaseAdmin);

    seedHotUpdater = createHotUpdater({
      database: supabaseDatabase({
        supabaseUrl: gatewayBaseUrl,
        supabaseAnonKey: SERVICE_ROLE_KEY,
      }),
      storages: [
        supabaseStorage({
          supabaseUrl: gatewayBaseUrl,
          supabaseAnonKey: SERVICE_ROLE_KEY,
          bucketName: BUCKET_NAME,
        }),
      ],
      basePath: HOT_UPDATER_BASE_PATH,
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    edgeRuntime = spawnRuntime({
      command: "docker",
      args: [
        "run",
        "--rm",
        "--network",
        `${composeProjectName}_default`,
        "-p",
        `127.0.0.1:${edgePort}:8000`,
        "-e",
        `SUPABASE_URL=http://gateway:8000`,
        "-e",
        `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`,
        "-e",
        "DENO_DIR=/deno-dir",
        "-v",
        `${WORKSPACE_ROOT}:${WORKSPACE_ROOT}:ro`,
        "-v",
        `${runtimeRoot}:${runtimeRoot}`,
        "-v",
        `${DENO_CACHE_VOLUME}:/deno-dir`,
        "-w",
        runtimeRoot,
        DENO_DOCKER_IMAGE,
        "run",
        "--no-lock",
        "--node-modules-dir=manual",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        "--allow-sys",
        "--unstable-sloppy-imports",
        "--import-map",
        path.join(runtimeRoot, "import_map.json"),
        path.join(runtimeRoot, "supabase/edge-functions/index.ts"),
      ],
      cwd: WORKSPACE_ROOT,
    });

    await waitForHttpOk({
      url: `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}/ping`,
      child: edgeRuntime.child,
      logs: edgeRuntime.logs,
      timeoutMs: 90_000,
    });
  }, 180_000);

  beforeEach(async () => {
    if (!supabaseAdmin) {
      throw new Error("Supabase admin client was not initialized.");
    }

    const { error } = await supabaseAdmin
      .from("bundles")
      .delete()
      .neq("id", NIL_UUID);

    if (error) {
      throw error;
    }
  });

  afterAll(async () => {
    if (edgeRuntime) {
      await stopRuntime(edgeRuntime.child);
    }

    if (composeFilePath) {
      try {
        runCheckedCommand({
          command: "docker",
          args: [
            "compose",
            "-p",
            composeProjectName,
            "-f",
            composeFilePath,
            "down",
            "-v",
            "--remove-orphans",
          ],
          cwd: WORKSPACE_ROOT,
        });
      } catch {
        // ignore cleanup failures
      }
    }

    if (runtimeRoot) {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 60_000);

  const seedRuntimeBundles = async (bundles: Bundle[]) => {
    for (const bundle of bundles.map(toRuntimeBundle)) {
      await seedHotUpdater.insertBundle(bundle);
    }
  };

  const requestUpdateInfo = async (args: GetBundlesArgs) => {
    const response = await fetch(
      `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}${createCanonicalPath(args)}`,
    );

    return (await response.json()) as any;
  };

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    if (!supabaseAdmin) {
      throw new Error("Supabase admin client was not initialized.");
    }

    for (const bundle of bundles) {
      await uploadBundleObject(supabaseAdmin, bundle.id);
    }
    await seedRuntimeBundles(bundles);
    return requestUpdateInfo(args);
  };

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
    manifestArtifacts: {
      prepareArtifacts: async (fixture) => {
        await Promise.all([
          uploadStorageObject(
            supabaseAdmin,
            `${fixture.currentBundleId}/manifest.json`,
            JSON.stringify(fixture.currentManifest),
            "application/json",
          ),
          uploadStorageObject(
            supabaseAdmin,
            `${fixture.nextBundleId}/manifest.json`,
            JSON.stringify(fixture.nextManifest),
            "application/json",
          ),
        ]);

        return {
          currentMetadata: {
            asset_base_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.currentBundleId}/files`,
            manifest_file_hash: "sig:manifest-current",
            manifest_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.currentBundleId}/manifest.json`,
          },
          nextMetadata: {
            asset_base_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.nextBundleId}/files`,
            manifest_file_hash: "sig:manifest-next",
            manifest_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.nextBundleId}/manifest.json`,
          },
        };
      },
      expectFileUrl: (fileUrl, fixture) => {
        expect(fileUrl).toContain(
          `/storage/v1/object/sign/${BUCKET_NAME}/${fixture.nextBundleId}/files/${fixture.changedAssetPath}`,
        );
      },
      expectManifestUrl: (manifestUrl, fixture) => {
        expect(manifestUrl).toContain(
          `/storage/v1/object/sign/${BUCKET_NAME}/${fixture.nextBundleId}/manifest.json`,
        );
      },
    },
  });

  setupBsdiffManifestUpdateInfoTestSuite({
    seedBundles: seedRuntimeBundles,
    getUpdateInfo: requestUpdateInfo,
    prepareArtifacts: async (fixture) => {
      await Promise.all([
        uploadStorageObject(
          supabaseAdmin,
          `${fixture.currentBundleId}/manifest.json`,
          JSON.stringify(fixture.currentManifest),
          "application/json",
        ),
        uploadStorageObject(
          supabaseAdmin,
          `${fixture.nextBundleId}/manifest.json`,
          JSON.stringify(fixture.nextManifest),
          "application/json",
        ),
        uploadStorageObject(
          supabaseAdmin,
          fixture.patchPath,
          "patch-bytes",
          "application/octet-stream",
        ),
        uploadBundleObject(supabaseAdmin, fixture.currentBundleId),
        uploadBundleObject(supabaseAdmin, fixture.nextBundleId),
      ]);

      return {
        currentMetadata: {
          asset_base_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.currentBundleId}/files`,
          manifest_file_hash: "sig:manifest-current",
          manifest_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.currentBundleId}/manifest.json`,
        },
        nextMetadata: {
          asset_base_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.nextBundleId}/files`,
          diff_base_bundle_id: fixture.currentBundleId,
          hbc_patch_algorithm: "bsdiff",
          hbc_patch_asset_path: fixture.assetPath,
          hbc_patch_base_file_hash: "hash-old-bundle",
          hbc_patch_file_hash: "hash-bsdiff",
          hbc_patch_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.patchPath}`,
          manifest_file_hash: "sig:manifest-next",
          manifest_storage_uri: `supabase-storage://${BUCKET_NAME}/${fixture.nextBundleId}/manifest.json`,
        },
      };
    },
    expectPatchUrl: (patchUrl, fixture) => {
      expect(patchUrl).toContain(
        `/storage/v1/object/sign/${BUCKET_NAME}/${fixture.patchPath}`,
      );
    },
  });

  it("serves canonical routes from the edge function entrypoint", async () => {
    const bundle = toRuntimeBundle({
      id: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
      targetAppVersion: "1.0",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: "hash",
      gitCommitHash: null,
      message: "hello",
      channel: "production",
      storageUri: "storage://unused",
      fingerprintHash: null,
    });

    await uploadBundleObject(supabaseAdmin, bundle.id);
    await seedHotUpdater.insertBundle(bundle);

    const response = await fetch(
      `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}${createCanonicalPath({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      })}`,
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
  });

  it("does not support the legacy exact path", async () => {
    const response = await fetch(
      `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}${LEGACY_HOT_UPDATER_BASE_PATH}`,
    );

    expect(response.status).toBe(404);
  });

  it("does not expose management routes from the edge function entrypoint", async () => {
    const response = await fetch(
      `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}/api/bundles`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });
});

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createLegacyJwt(role: "anon" | "service_role") {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      role,
      iss: "supabase-test",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS,
    }),
  );
  const signature = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${header}.${payload}.${signature}`;
}

const waitForUrlOk = async (url: string, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }

      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
};

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const ensureBucketExists = async (
  supabaseAdmin: ReturnType<typeof createClient>,
) => {
  const { data: buckets, error: listError } =
    await supabaseAdmin.storage.listBuckets();

  if (listError) {
    throw listError;
  }

  if (buckets.some((bucket) => bucket.name === BUCKET_NAME)) {
    return;
  }

  const { error } = await supabaseAdmin.storage.createBucket(BUCKET_NAME);

  if (error) {
    throw error;
  }
};

const uploadBundleObject = async (
  supabaseAdmin: ReturnType<typeof createClient>,
  bundleId: string,
) => {
  await uploadStorageObject(
    supabaseAdmin,
    `${bundleId}/bundle.zip`,
    Buffer.from("zip"),
    "application/zip",
  );
};

const uploadStorageObject = async (
  supabaseAdmin: ReturnType<typeof createClient>,
  key: string,
  body: string | Buffer,
  contentType: string,
) => {
  const { error } = await supabaseAdmin.storage
    .from(BUCKET_NAME)
    .upload(key, body, {
      contentType,
      cacheControl: "31536000",
      upsert: true,
    });

  if (error) {
    throw error;
  }
};

const loadSupabaseInitSql = async (storageRepoPath: string) => {
  const storageMigrationsDir = path.join(storageRepoPath, "migrations/tenant");
  const storageMigrationFiles = (await readdir(storageMigrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const storageMigrations = await Promise.all(
    storageMigrationFiles.map(async (file) => {
      const contents = await readFile(
        path.join(storageMigrationsDir, file),
        "utf8",
      );
      const trimmed = contents.trimEnd();
      return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
    }),
  );

  const migrationsDir = path.join(
    WORKSPACE_ROOT,
    "plugins/supabase/supabase/migrations",
  );
  const migrationFiles = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    migrationFiles.map(async (file) => {
      const contents = await readFile(path.join(migrationsDir, file), "utf8");
      return contents.replaceAll("%%BUCKET_NAME%%", BUCKET_NAME);
    }),
  );

  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN PASSWORD '${POSTGRES_PASSWORD}' NOINHERIT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin'
  ) THEN
    CREATE ROLE supabase_storage_admin LOGIN PASSWORD '${POSTGRES_PASSWORD}' SUPERUSER;
  END IF;
END $$;

GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;

${migrations.join("\n\n")}

SET search_path TO storage, public, extensions;

${storageMigrations.join("\n\n")}

SET search_path TO public;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON TYPE platforms TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`.trim();
};

const createComposeFile = ({
  gatewayPort,
  runtimeRoot,
}: {
  gatewayPort: number;
  runtimeRoot: string;
}) => {
  return `
services:
  db:
    image: ${POSTGRES_IMAGE}
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 20
    volumes:
      - ${path.join(runtimeRoot, "db-init")}:/docker-entrypoint-initdb.d:ro

  rest:
    image: ${POSTGREST_IMAGE}
    depends_on:
      db:
        condition: service_healthy
    environment:
      PGRST_DB_URI: postgres://authenticator:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      PGRST_DB_SCHEMAS: public,storage
      PGRST_DB_MAX_ROWS: 1000
      PGRST_DB_EXTRA_SEARCH_PATH: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: "false"
      PGRST_APP_SETTINGS_JWT_SECRET: ${JWT_SECRET}
      PGRST_APP_SETTINGS_JWT_EXP: "3600"

  imgproxy:
    image: ${IMGPROXY_IMAGE}
    environment:
      IMGPROXY_BIND: ":5001"
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: /
      IMGPROXY_USE_ETAG: "true"

  storage:
    image: ${STORAGE_IMAGE}
    depends_on:
      db:
        condition: service_healthy
      rest:
        condition: service_started
      imgproxy:
        condition: service_started
    environment:
      ANON_KEY: ${ANON_KEY}
      SERVICE_KEY: ${SERVICE_ROLE_KEY}
      POSTGREST_URL: http://rest:3000
      AUTH_JWT_SECRET: ${JWT_SECRET}
      DATABASE_URL: postgres://supabase_storage_admin:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      STORAGE_PUBLIC_URL: http://gateway:8000
      REQUEST_ALLOW_X_FORWARDED_PATH: "true"
      FILE_SIZE_LIMIT: 52428800
      STORAGE_BACKEND: file
      GLOBAL_S3_BUCKET: ${BUCKET_NAME}
      FILE_STORAGE_BACKEND_PATH: /var/lib/storage
      TENANT_ID: stub
      REGION: stub
      ENABLE_IMAGE_TRANSFORMATION: "false"
      IMGPROXY_URL: http://imgproxy:5001
      S3_PROTOCOL_ACCESS_KEY_ID: stub
      S3_PROTOCOL_ACCESS_KEY_SECRET: stub
    volumes:
      - storage-data:/var/lib/storage

  gateway:
    image: ${NGINX_IMAGE}
    depends_on:
      storage:
        condition: service_started
      rest:
        condition: service_started
    ports:
      - "127.0.0.1:${gatewayPort}:8000"
    volumes:
      - ${path.join(runtimeRoot, "nginx.conf")}:/etc/nginx/nginx.conf:ro

volumes:
  storage-data:
`.trim();
};

const createNginxConfig = () => {
  return `
events {}

http {
  client_max_body_size 100m;

  server {
    listen 8000;

    location /rest/v1/ {
      proxy_pass http://rest:3000/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Authorization $http_authorization;
      proxy_set_header apikey $http_apikey;
      proxy_set_header Content-Profile $http_content_profile;
      proxy_set_header Accept-Profile $http_accept_profile;
      proxy_set_header Prefer $http_prefer;
      proxy_set_header Range $http_range;
      proxy_set_header Range-Unit $http_range_unit;
      proxy_set_header Content-Type $http_content_type;
    }

    location /storage/v1/ {
      proxy_pass http://storage:5000/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Authorization $http_authorization;
      proxy_set_header apikey $http_apikey;
      proxy_set_header x-forwarded-path $request_uri;
      proxy_set_header Content-Type $http_content_type;
      proxy_set_header Content-Length $content_length;
    }
  }
}
`.trim();
};

const writeSupabaseRuntimeFiles = async ({
  runtimeRoot,
  gatewayPort,
  storageRepoPath,
}: {
  runtimeRoot: string;
  gatewayPort: number;
  storageRepoPath: string;
}) => {
  await mkdir(path.join(runtimeRoot, "db-init"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "supabase/edge-functions"), {
    recursive: true,
  });
  await symlink(
    path.join(WORKSPACE_ROOT, "plugins/supabase/src"),
    path.join(runtimeRoot, "src"),
  );
  await symlink(
    path.join(WORKSPACE_ROOT, "plugins/supabase/node_modules"),
    path.join(runtimeRoot, "node_modules"),
  );

  const transformedEntry = transformEnv(
    path.join(
      WORKSPACE_ROOT,
      "plugins/supabase/supabase/edge-functions/index.ts",
    ),
    {
      FUNCTION_NAME,
    },
  );
  const importMap = {
    imports: {
      "@hot-updater/server/runtime": pathToFileURL(
        path.join(WORKSPACE_ROOT, "packages/server/dist/runtime.mjs"),
      ).href,
      "@hot-updater/supabase": pathToFileURL(
        path.join(runtimeRoot, "hot-updater-supabase-edge.ts"),
      ).href,
    },
  };

  await writeFile(
    path.join(runtimeRoot, "hot-updater-supabase-edge.ts"),
    `
export { supabaseEdgeFunctionDatabase } from ${JSON.stringify(pathToFileURL(path.join(WORKSPACE_ROOT, "plugins/supabase/src/supabaseEdgeFunctionDatabase.ts")).href)};
export { supabaseEdgeFunctionStorage } from ${JSON.stringify(pathToFileURL(path.join(WORKSPACE_ROOT, "plugins/supabase/src/supabaseEdgeFunctionStorage.ts")).href)};
`.trim(),
  );
  await writeFile(
    path.join(runtimeRoot, "supabase/edge-functions/index.ts"),
    transformedEntry,
  );
  await writeFile(
    path.join(runtimeRoot, "import_map.json"),
    JSON.stringify(importMap),
  );
  await writeFile(
    path.join(runtimeRoot, "db-init/00-init.sql"),
    await loadSupabaseInitSql(storageRepoPath),
  );
  await writeFile(
    path.join(runtimeRoot, "docker-compose.yml"),
    createComposeFile({ runtimeRoot, gatewayPort }),
  );
  await writeFile(path.join(runtimeRoot, "nginx.conf"), createNginxConfig());
};
