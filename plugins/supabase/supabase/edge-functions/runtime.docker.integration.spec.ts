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
import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
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
const AUTHORITY_ID = "supabase.runtime-acceptance";
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
    path: path.join(WORKSPACE_ROOT, "packages/server/dist/index.mjs"),
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

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    storageUri: `supabase-storage://${BUCKET_NAME}/${bundle.id}/bundle.zip`,
  };
};

const runtimeBundle = (id: string, overrides: Partial<Bundle> = {}): Bundle =>
  toRuntimeBundle({
    platform: "ios",
    targetAppVersion: "1.0.0",
    shouldForceUpdate: false,
    enabled: true,
    fileHash: `hash-${id}`,
    gitCommitHash: null,
    message: null,
    channel: "production",
    storageUri: "storage://unused",
    fingerprintHash: null,
    ...overrides,
    id,
  });

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
  let databaseClient: ReturnType<typeof createDatabaseClient>;
  let supabaseAdmin: ReturnType<typeof createClient>;

  const runDatabaseSql = (statement: string): void => {
    runCheckedCommand({
      command: "docker",
      args: [
        "compose",
        "-p",
        composeProjectName,
        "-f",
        composeFilePath,
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "postgres",
        "-d",
        POSTGRES_DB,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement,
      ],
      cwd: WORKSPACE_ROOT,
    });
  };

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

    await waitForRestApiReady(gatewayBaseUrl, 180_000);
    await waitForUrlOk(`${gatewayBaseUrl}/storage/v1/status`, 180_000);

    supabaseAdmin = createClient(gatewayBaseUrl, SERVICE_ROLE_KEY);
    await ensureBucketExists(supabaseAdmin);

    databaseClient = createDatabaseClient(
      supabaseDatabase({
        supabaseUrl: gatewayBaseUrl,
        supabaseServiceRoleKey: SERVICE_ROLE_KEY,
      }),
    );

    seedHotUpdater = createHotUpdater({
      authorityId: AUTHORITY_ID,
      database: supabaseDatabase({
        supabaseUrl: gatewayBaseUrl,
        supabaseServiceRoleKey: SERVICE_ROLE_KEY,
      }),
      storage: [
        supabaseStorage({
          supabaseUrl: gatewayBaseUrl,
          supabaseServiceRoleKey: SERVICE_ROLE_KEY,
          bucketName: BUCKET_NAME,
        }),
      ],
      clientBasePath: HOT_UPDATER_BASE_PATH,
      features: {
        updateCheck: true,
      },
    });

    edgeRuntime = spawnRuntime({
      command: "docker",
      args: [
        "run",
        "--rm",
        "--network",
        `${composeProjectName}_default`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-p",
        `127.0.0.1:${edgePort}:8000`,
        "-e",
        `SUPABASE_URL=http://host.docker.internal:${gatewayPort}`,
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
  }, 300_000);

  beforeEach(async () => {
    if (!supabaseAdmin) {
      throw new Error("Supabase admin client was not initialized.");
    }

    for (const [table, key] of [
      ["release_catalogs", "scope_key"],
      ["releases", "id"],
      ["bundle_patches", "id"],
      ["bundles", "id"],
      ["channels", "id"],
    ] as const) {
      const { error } = await supabaseAdmin
        .from(table)
        .delete()
        .neq(key, NIL_UUID);
      if (error) throw error;
    }
  });

  afterAll(async () => {
    if (edgeRuntime) {
      await stopRuntime(edgeRuntime.child);
    }

    if (composeFilePath) {
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
    }

    if (runtimeRoot) {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("returns one canonical Channel row under concurrent inserts", async () => {
    const database = supabaseDatabase({
      supabaseUrl: gatewayBaseUrl,
      supabaseServiceRoleKey: SERVICE_ROLE_KEY,
    });
    const channelName = "concurrent-channel";
    const results = await Promise.all([
      database.models.channels.insert({
        row: {
          id: "00000000-0000-0000-0000-000000000091",
          name: channelName,
        },
        onConflict: "returnExisting",
      }),
      database.models.channels.insert({
        row: {
          id: "00000000-0000-0000-0000-000000000092",
          name: channelName,
        },
        onConflict: "returnExisting",
      }),
    ]);

    expect(new Set(results.map(({ row }) => row.id)).size).toBe(1);
    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
    const stored = await supabaseAdmin
      .from("channels")
      .select("id, name")
      .eq("name", channelName);
    if (stored.error) throw stored.error;
    expect(stored.data).toEqual([results[0]?.row]);
  });

  it("rolls back a patch-bearing insert when one base bundle is missing", async () => {
    const base = runtimeBundle("00000000-0000-0000-0000-000000000101");
    const owner = {
      ...base,
      id: "00000000-0000-0000-0000-000000000102",
      fileHash: "hash-owner",
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "hash-valid-patch",
          patchStorageUri: "storage://valid-patch",
        },
        {
          baseBundleId: "00000000-0000-0000-0000-000000000199",
          baseFileHash: "hash-missing-base",
          patchFileHash: "hash-invalid-patch",
          patchStorageUri: "storage://invalid-patch",
        },
      ],
    } satisfies Bundle;
    await databaseClient.insertBundle(base);

    await expect(
      databaseClient.mutate((database) => database.insertBundle(owner)),
    ).rejects.toBeDefined();

    const ownerResult = await supabaseAdmin
      .from("bundles")
      .select("id")
      .eq("id", owner.id)
      .maybeSingle();
    if (ownerResult.error) throw ownerResult.error;
    expect(ownerResult.data).toBeNull();
    const patchResult = await supabaseAdmin
      .from("bundle_patches")
      .select("id")
      .eq("bundle_id", owner.id);
    if (patchResult.error) throw patchResult.error;
    expect(patchResult.data).toEqual([]);
  });

  it("preserves extension defaults and generated values during atomic inserts", async () => {
    runDatabaseSql(
      [
        "ALTER TABLE public.bundles",
        "ADD COLUMN tenant_tag text NOT NULL DEFAULT 'default-tenant',",
        "ADD COLUMN file_hash_upper text GENERATED ALWAYS AS (upper(file_hash)) STORED",
      ].join(" "),
    );

    try {
      const base = runtimeBundle("00000000-0000-0000-0000-000000000151");
      const owner = {
        ...base,
        id: "00000000-0000-0000-0000-000000000152",
        fileHash: "hash-owner",
        patches: [
          {
            baseBundleId: base.id,
            baseFileHash: base.fileHash,
            patchFileHash: "hash-patch",
            patchStorageUri: "storage://patch",
          },
        ],
      } satisfies Bundle;
      await databaseClient.insertBundle(base);

      await databaseClient.insertBundle(owner);

      const result = await supabaseAdmin
        .from("bundles")
        .select("tenant_tag, file_hash_upper")
        .eq("id", owner.id)
        .single();
      if (result.error) throw result.error;
      expect(result.data).toEqual({
        tenant_tag: "default-tenant",
        file_hash_upper: "HASH-OWNER",
      });
    } finally {
      runDatabaseSql(
        "ALTER TABLE public.bundles DROP COLUMN tenant_tag, DROP COLUMN file_hash_upper",
      );
    }
  });

  it("does not resolve public-schema JSON function shadows in atomic RPCs", async () => {
    runDatabaseSql(`
      CREATE FUNCTION public.jsonb_populate_record(public.bundles, jsonb)
      RETURNS public.bundles
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'public jsonb_populate_record shadow executed';
      END;
      $$
    `);

    try {
      const base = runtimeBundle("00000000-0000-0000-0000-000000000551");
      const owner = {
        ...base,
        id: "00000000-0000-0000-0000-000000000552",
        fileHash: "hash-owner",
        patches: [
          {
            baseBundleId: base.id,
            baseFileHash: base.fileHash,
            patchFileHash: "hash-patch",
            patchStorageUri: "storage://patch",
          },
        ],
      } satisfies Bundle;
      await databaseClient.insertBundle(base);

      await databaseClient.insertBundle(owner);

      await expect(
        databaseClient.getBundleById(owner.id),
      ).resolves.toMatchObject({ id: owner.id, patches: owner.patches });
    } finally {
      runDatabaseSql(
        "DROP FUNCTION public.jsonb_populate_record(public.bundles, jsonb)",
      );
    }
  });

  it("rolls back scalar and patch replacement when a new base is missing", async () => {
    const base = runtimeBundle("00000000-0000-0000-0000-000000000201");
    const owner = {
      ...base,
      id: "00000000-0000-0000-0000-000000000202",
      fileHash: "hash-owner",
      gitCommitHash: "before",
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "hash-old-patch",
          patchStorageUri: "storage://old-patch",
        },
      ],
    } satisfies Bundle;
    await databaseClient.insertBundle(base);
    await databaseClient.insertBundle(owner);

    await expect(
      databaseClient.mutate((database) =>
        database.updateBundleById(owner.id, {
          gitCommitHash: "after",
          patches: [
            {
              baseBundleId: "00000000-0000-0000-0000-000000000299",
              baseFileHash: "hash-missing-base",
              patchFileHash: "hash-invalid-patch",
              patchStorageUri: "storage://invalid-patch",
            },
          ],
        }),
      ),
    ).rejects.toBeDefined();

    await expect(databaseClient.getBundleById(owner.id)).resolves.toMatchObject(
      {
        gitCommitHash: "before",
        patches: owner.patches,
      },
    );
  });

  it("atomically applies explicit nulls and an empty patch list", async () => {
    const base = runtimeBundle("00000000-0000-0000-0000-000000000301");
    const owner = {
      ...base,
      id: "00000000-0000-0000-0000-000000000302",
      fileHash: "hash-owner",
      gitCommitHash: "before",
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: "hash-old-patch",
          patchStorageUri: "storage://old-patch",
        },
      ],
    } satisfies Bundle;
    await databaseClient.insertBundle(base);
    await databaseClient.insertBundle(owner);

    await databaseClient.mutate((database) =>
      database.updateBundleById(owner.id, {
        gitCommitHash: null,
        patches: [],
      }),
    );

    await expect(databaseClient.getBundleById(owner.id)).resolves.toMatchObject(
      {
        gitCommitHash: null,
        patches: [],
      },
    );
  });

  it("maps a missing aggregate update to the public not-found error", async () => {
    const result = databaseClient.updateBundleById(
      "00000000-0000-0000-0000-000000000401",
      { patches: [] },
    );

    await expect(result).rejects.toMatchObject({
      name: "DatabaseBundleNotFoundError",
      bundleId: "00000000-0000-0000-0000-000000000401",
    });
  });

  it("denies the generic commit RPC to the anonymous role", async () => {
    const response = await fetch(
      `${gatewayBaseUrl}/rest/v1/rpc/hot_updater_commit`,
      {
        method: "POST",
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_commit: { changes: [] } }),
      },
    );

    expect(response.ok).toBe(false);
  });

  it("serves unversioned Release Catalog routes from the edge function entrypoint", async () => {
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
      `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}/release-catalogs/app-version/${encodeURIComponent(AUTHORITY_ID)}/ios/cHJvZHVjdGlvbg/1.0.0`,
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      releases: [{ bundleId: "00000000-0000-0000-0000-000000000001" }],
    });
  });

  it("does not support the legacy exact path", async () => {
    const response = await fetch(
      `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}/api/check-update`,
    );

    expect(response.status).toBe(404);
  });

  it("does not expose management routes from the edge function entrypoint", async () => {
    const response = await fetch(
      `http://127.0.0.1:${edgePort}${FUNCTION_BASE_PATH}/admin/bundles`,
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

const waitForRestApiReady = async (baseUrl: string, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${baseUrl}/rest/v1/bundles?select=id&limit=1`,
        {
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          },
        },
      );
      if (response.ok) {
        return;
      }

      lastError = `${response.status} ${response.statusText}: ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for PostgREST: ${lastError}`);
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
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.hot_updater_commit(jsonb)
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.hot_updater_delete_channel(text)
  FROM anon, authenticated;

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
    restart: on-failure
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
      - "0.0.0.0:${gatewayPort}:8000"
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
      AUTHORITY_ID,
      BUCKET_NAME,
      FUNCTION_NAME,
    },
  );
  const importMap = {
    imports: {
      "@hot-updater/server": pathToFileURL(
        path.join(WORKSPACE_ROOT, "packages/server/dist/index.mjs"),
      ).href,
      "@hot-updater/supabase/edge": pathToFileURL(
        path.join(runtimeRoot, "hot-updater-supabase-edge.ts"),
      ).href,
    },
  };

  await writeFile(
    path.join(runtimeRoot, "hot-updater-supabase-edge.ts"),
    `
export { supabaseDatabase } from ${JSON.stringify(pathToFileURL(path.join(WORKSPACE_ROOT, "plugins/supabase/src/supabaseDatabase.ts")).href)};
export { supabaseEdgeFunctionStorage as supabaseStorage } from ${JSON.stringify(pathToFileURL(path.join(WORKSPACE_ROOT, "plugins/supabase/src/supabaseEdgeFunctionStorage.ts")).href)};
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
