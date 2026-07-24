import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analytics, type AnalyticsAPI } from "@hot-updater/analytics";
import { apiKey } from "@hot-updater/api-key";
import { transformEnv } from "@hot-updater/cli-tools";
import {
  type AppUpdateInfo,
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server";
import {
  setupBsdiffManifestUpdateInfoTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import admin from "firebase-admin";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertCommandAvailable,
  findOpenPort,
  spawnRuntime,
  stopRuntime,
  waitForHttpOk,
} from "../../../../packages/test-utils/src/runtimeProcess";
import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseFunctionsStorage } from "../../src/firebaseFunctionsStorage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../..");
const REGION = "us-central1";
const FUNCTION_NAME = "hot-updater";
const HOT_UPDATER_BASE_PATH = "/api/check-update";
const API_KEY = Buffer.alloc(32, 1).toString("base64url");
const INVALID_API_KEY = Buffer.alloc(32, 2).toString("base64url");
const API_KEY_SHA256 = createHash("sha256").update(API_KEY).digest("base64url");

class InvalidUpdateResponseError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUpdateResponse = (
  value: unknown,
): value is AppUpdateInfo | UpdateInfo | null => {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "UP_TO_DATE") return true;
  return (
    (value.status === "ROLLBACK" || value.status === "UPDATE") &&
    typeof value.id === "string" &&
    typeof value.shouldForceUpdate === "boolean" &&
    (value.message === null || typeof value.message === "string") &&
    (value.fileHash === null || typeof value.fileHash === "string") &&
    (value.fileUrl === null ||
      typeof value.fileUrl === "string" ||
      value.storageUri === null ||
      typeof value.storageUri === "string")
  );
};

const FIREBASE_CLI_VERSION_ARGS = [
  "--filter",
  "@hot-updater/firebase",
  "exec",
  "firebase",
  "--version",
] as const;
const REQUIRED_BUILD_ARTIFACTS = [
  {
    command: "pnpm --filter @hot-updater/firebase... build",
    path: path.join(
      WORKSPACE_ROOT,
      "plugins/firebase/dist/firebase/public/firebase.json",
    ),
  },
  {
    command: "pnpm --filter @hot-updater/firebase... build",
    path: path.join(
      WORKSPACE_ROOT,
      "plugins/firebase/dist/firebase/public/firestore.indexes.json",
    ),
  },
  {
    command: "pnpm --filter @hot-updater/firebase... build",
    path: path.join(
      WORKSPACE_ROOT,
      "plugins/firebase/dist/firebase/public/functions/_package.json",
    ),
  },
  {
    command: "pnpm --filter @hot-updater/firebase... build",
    path: path.join(
      WORKSPACE_ROOT,
      "plugins/firebase/dist/firebase/functions/index.cjs",
    ),
  },
] as const;

assertCommandAvailable(
  "pnpm",
  [...FIREBASE_CLI_VERSION_ARGS],
  "firebase functions runtime acceptance requires the Firebase CLI in the @hot-updater/firebase workspace.",
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

  if (args._updateStrategy === "appVersion") {
    return `${HOT_UPDATER_BASE_PATH}/app-version/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.appVersion)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
  }

  return `${HOT_UPDATER_BASE_PATH}/fingerprint/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.fingerprintHash)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
};

const toRuntimeBundle = (bundle: Bundle, storageBucket: string): Bundle => {
  return {
    ...bundle,
    storageUri: `gs://${storageBucket}/${bundle.id}/bundle.zip`,
  };
};

describe("firebase functions deployment artifact", () => {
  it("ships only the digest placeholder", async () => {
    // Given: the built Firebase Functions deployment artifact.
    const runtimeSource = await readFile(
      path.join(
        WORKSPACE_ROOT,
        "plugins/firebase/dist/firebase/functions/index.cjs",
      ),
      "utf8",
    );

    // When: the deployable credential references are inspected.
    const containsDigestPlaceholder = runtimeSource.includes(
      "HotUpdater.API_KEY_SHA256",
    );

    // Then: the artifact never reads or embeds the local raw credential.
    expect(containsDigestPlaceholder).toBe(true);
    expect(runtimeSource).not.toContain("HOT_UPDATER_API_KEY=");
    expect(runtimeSource).not.toContain("process.env.HOT_UPDATER_API_KEY");
    expect(runtimeSource).not.toContain(API_KEY);
  });
});

describe.sequential("firebase functions runtime acceptance", () => {
  const cdnObjects = new Map<string, { body: string; contentType: string }>();
  let cdnBaseUrl = "";
  let cdnServer: Server | undefined;
  let tempRoot: string | undefined;
  let functionsPort = 0;
  let functionsRuntime: ReturnType<typeof spawnRuntime> | undefined;
  let seedHotUpdater: ReturnType<typeof createHotUpdater> & AnalyticsAPI;
  const projectId = process.env.GCLOUD_PROJECT ?? "";
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "";
  const storageEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "";
  const storageBucket = `${projectId}.appspot.com`;

  beforeAll(async () => {
    if (!projectId || !firestoreHost || !storageEmulatorHost) {
      throw new Error(
        "Firebase acceptance tests require FIRESTORE_EMULATOR_HOST, FIREBASE_STORAGE_EMULATOR_HOST and GCLOUD_PROJECT.",
      );
    }

    await ensureBuiltArtifacts(REQUIRED_BUILD_ARTIFACTS);

    const cdnPort = await findOpenPort();
    cdnBaseUrl = `http://127.0.0.1:${cdnPort}`;
    cdnServer = await startFixtureCdn(cdnPort, cdnObjects);

    tempRoot = await mkdtemp(
      path.join(WORKSPACE_ROOT, "plugins/firebase/runtime-acceptance-"),
    );

    const firebaseConfig = JSON.parse(
      await readFile(
        path.join(
          WORKSPACE_ROOT,
          "plugins/firebase/dist/firebase/public/firebase.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    functionsPort = await findOpenPort();
    firebaseConfig.emulators = {
      functions: {
        host: "127.0.0.1",
        port: functionsPort,
      },
    };

    await writeFile(
      path.join(tempRoot, "firebase.json"),
      JSON.stringify(firebaseConfig),
    );
    await writeFile(
      path.join(tempRoot, "firestore.indexes.json"),
      await readFile(
        path.join(
          WORKSPACE_ROOT,
          "plugins/firebase/dist/firebase/public/firestore.indexes.json",
        ),
        "utf8",
      ),
    );

    const functionsDir = path.join(tempRoot, "functions");
    await mkdir(functionsDir, { recursive: true });
    await writeFile(
      path.join(functionsDir, "package.json"),
      await readFile(
        path.join(
          WORKSPACE_ROOT,
          "plugins/firebase/dist/firebase/public/functions/_package.json",
        ),
        "utf8",
      ),
    );
    await symlink(
      path.join(WORKSPACE_ROOT, "plugins/firebase/node_modules"),
      path.join(functionsDir, "node_modules"),
    );
    const firebaseFunctionsPackagePath = await realpath(
      path.join(
        WORKSPACE_ROOT,
        "plugins/firebase/node_modules/firebase-functions",
      ),
    );
    const firebaseFunctionsBinPath = path.join(
      functionsDir,
      "node_modules",
      ".bin",
      "firebase-functions",
    );
    await writeFile(
      firebaseFunctionsBinPath,
      `#!/bin/sh
exec node "${path.join(firebaseFunctionsPackagePath, "lib/bin/firebase-functions.js")}" "$@"
`,
    );
    await chmod(firebaseFunctionsBinPath, 0o755);
    await writeFile(
      path.join(functionsDir, "index.cjs"),
      transformEnv(
        path.join(
          WORKSPACE_ROOT,
          "plugins/firebase/dist/firebase/functions/index.cjs",
        ),
        {
          API_KEY_SHA256,
          REGION,
        },
      ),
    );

    const firebaseAdminApp = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ projectId, storageBucket });
    const adminOptions = {
      ...firebaseAdminApp.options,
      projectId,
      storageBucket,
    };

    seedHotUpdater = createHotUpdater({
      database: firebaseDatabase(adminOptions),
      storages: [
        firebaseFunctionsStorage({
          ...adminOptions,
          cdnUrl: cdnBaseUrl,
        })(),
      ],
      basePath: HOT_UPDATER_BASE_PATH,
      routes: {
        bundles: false,
        updateCheck: true,
      },
      plugins: [apiKey({ sha256: API_KEY_SHA256 }), analytics()],
    });

    functionsRuntime = spawnRuntime({
      command: "pnpm",
      args: [
        "--filter",
        "@hot-updater/firebase",
        "exec",
        "firebase",
        "emulators:start",
        "--project",
        projectId,
        "--only",
        "functions",
        "--config",
        path.join(tempRoot, "firebase.json"),
      ],
      cwd: WORKSPACE_ROOT,
      env: {
        FIRESTORE_EMULATOR_HOST: firestoreHost,
        FIREBASE_CONFIG: JSON.stringify({
          projectId,
          storageBucket,
        }),
        FIREBASE_STORAGE_EMULATOR_HOST: storageEmulatorHost,
        GCLOUD_PROJECT: projectId,
        HOT_UPDATER_CDN_URL: cdnBaseUrl,
      },
    });

    await waitForHttpOk({
      url: `http://127.0.0.1:${functionsPort}/${projectId}/${REGION}/${FUNCTION_NAME}/ping`,
      child: functionsRuntime.child,
      logs: functionsRuntime.logs,
      timeoutMs: 90_000,
    });
  }, 150_000);

  beforeEach(async () => {
    cdnObjects.clear();
    await clearStorageBucket(storageBucket);
    await clearFirestoreCollection("bundle_events");
    await clearFirestoreCollection("bundle_patches");
    await clearFirestoreCollection("bundles");
  });

  afterAll(async () => {
    if (functionsRuntime) {
      await stopRuntime(functionsRuntime.child);
    }

    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }

    if (cdnServer) {
      await closeServer(cdnServer);
    }
  });

  const invokeHandler = async (
    routePath: string,
    init?: RequestInit,
    apiKey: string | null = API_KEY,
  ) => {
    const headers = new Headers(init?.headers);
    if (apiKey !== null) {
      headers.set("x-api-key", apiKey);
    }
    return await fetch(
      `http://127.0.0.1:${functionsPort}/${projectId}/${REGION}/${FUNCTION_NAME}${routePath}`,
      { ...init, headers },
    );
  };

  const seedRuntimeBundles = async (bundles: Bundle[]) => {
    for (const bundle of bundles.map((bundle) =>
      toRuntimeBundle(bundle, storageBucket),
    )) {
      const existing = await seedHotUpdater.getBundleById(bundle.id);
      if (existing) {
        await seedHotUpdater.updateBundleById(bundle.id, bundle);
      } else {
        await seedHotUpdater.insertBundle(bundle);
      }
    }
  };

  const requestUpdateInfo = async (args: GetBundlesArgs) => {
    const response = await invokeHandler(createCanonicalPath(args));

    const result: unknown = await response.json();
    if (!isUpdateResponse(result)) throw new InvalidUpdateResponseError();
    return result;
  };

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    await seedRuntimeBundles(bundles);
    return requestUpdateInfo(args);
  };

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
    manifestArtifacts: {
      prepareArtifacts: async (fixture) => {
        seedCdnObject(
          cdnObjects,
          `${fixture.currentBundleId}/manifest.json`,
          JSON.stringify(fixture.currentManifest),
          "application/json",
        );
        await seedStorageObject(
          storageBucket,
          `${fixture.currentBundleId}/manifest.json`,
          JSON.stringify(fixture.currentManifest),
          "application/json",
        );
        seedCdnObject(
          cdnObjects,
          `${fixture.nextBundleId}/manifest.json`,
          JSON.stringify(fixture.nextManifest),
          "application/json",
        );
        await seedStorageObject(
          storageBucket,
          `${fixture.nextBundleId}/manifest.json`,
          JSON.stringify(fixture.nextManifest),
          "application/json",
        );

        return {
          currentArtifacts: {
            assetBaseStorageUri: `gs://${storageBucket}/${fixture.currentBundleId}/files`,
            manifestFileHash: "sig:manifest-current",
            manifestStorageUri: `gs://${storageBucket}/${fixture.currentBundleId}/manifest.json`,
          },
          nextArtifacts: {
            assetBaseStorageUri: `gs://${storageBucket}/${fixture.nextBundleId}/files`,
            manifestFileHash: "sig:manifest-next",
            manifestStorageUri: `gs://${storageBucket}/${fixture.nextBundleId}/manifest.json`,
          },
        };
      },
      expectFileUrl: (fileUrl, fixture) => {
        expect(fileUrl).toBe(
          `${cdnBaseUrl}/${fixture.nextBundleId}/files/${fixture.changedAssetPath}.br`,
        );
      },
      expectManifestUrl: (manifestUrl, fixture) => {
        expect(manifestUrl).toBe(
          `${cdnBaseUrl}/${fixture.nextBundleId}/manifest.json`,
        );
      },
    },
  });

  setupBsdiffManifestUpdateInfoTestSuite({
    seedBundles: seedRuntimeBundles,
    getUpdateInfo: requestUpdateInfo,
    prepareArtifacts: async (fixture) => {
      seedCdnObject(
        cdnObjects,
        `${fixture.currentBundleId}/manifest.json`,
        JSON.stringify(fixture.currentManifest),
        "application/json",
      );
      await seedStorageObject(
        storageBucket,
        `${fixture.currentBundleId}/manifest.json`,
        JSON.stringify(fixture.currentManifest),
        "application/json",
      );
      seedCdnObject(
        cdnObjects,
        `${fixture.nextBundleId}/manifest.json`,
        JSON.stringify(fixture.nextManifest),
        "application/json",
      );
      await seedStorageObject(
        storageBucket,
        `${fixture.nextBundleId}/manifest.json`,
        JSON.stringify(fixture.nextManifest),
        "application/json",
      );
      seedCdnObject(
        cdnObjects,
        fixture.patchPath,
        "patch-bytes",
        "application/octet-stream",
      );
      seedCdnObject(cdnObjects, `${fixture.currentBundleId}/bundle.zip`, "zip");
      seedCdnObject(cdnObjects, `${fixture.nextBundleId}/bundle.zip`, "zip");

      return {
        currentArtifacts: {
          assetBaseStorageUri: `gs://${storageBucket}/${fixture.currentBundleId}/files`,
          manifestFileHash: "sig:manifest-current",
          manifestStorageUri: `gs://${storageBucket}/${fixture.currentBundleId}/manifest.json`,
        },
        nextArtifacts: {
          assetBaseStorageUri: `gs://${storageBucket}/${fixture.nextBundleId}/files`,
          manifestFileHash: "sig:manifest-next",
          manifestStorageUri: `gs://${storageBucket}/${fixture.nextBundleId}/manifest.json`,
          patches: [
            {
              baseBundleId: fixture.currentBundleId,
              baseFileHash: "hash-old-bundle",
              patchFileHash: "hash-bsdiff",
              patchStorageUri: `gs://${storageBucket}/${fixture.patchPath}`,
            },
          ],
        },
      };
    },
    expectPatchUrl: (patchUrl, fixture) => {
      expect(patchUrl).toBe(`${cdnBaseUrl}/${fixture.patchPath}`);
    },
  });

  it("serves canonical routes from the emulator entrypoint", async () => {
    await seedHotUpdater.insertBundle(
      toRuntimeBundle(
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
          storageUri: "storage://unused",
          fingerprintHash: null,
        },
        storageBucket,
      ),
    );

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

  it("ingests events from the managed function by default", async () => {
    // Given: the client sends a valid OTA transition.
    const bundleId = "00000000-0000-0000-0000-000000000001";

    // When: the event is sent to the managed runtime default.
    const response = await invokeHandler(`${HOT_UPDATER_BASE_PATH}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appVersion: "1.0",
        channel: "production",
        cohort: "782",
        fingerprintHash: null,
        fromBundleId: NIL_UUID,
        installId: "firebase-e2e-install",
        platform: "ios",
        toBundleId: bundleId,
        type: "UPDATE_APPLIED",
        updateStrategy: "appVersion",
      }),
    });

    // Then: the managed runtime persists the event.
    expect(response.status).toBe(204);
    await expect(
      seedHotUpdater.getBundleEventSummary(bundleId),
    ).resolves.toEqual({ installed: 1, recovered: 0 });
  });

  it("measures the original Firebase request body before ingesting", async () => {
    const payload = JSON.stringify({
      appVersion: "1.0",
      channel: "production",
      cohort: "782",
      fingerprintHash: null,
      fromBundleId: NIL_UUID,
      installId: "firebase-oversized-install",
      platform: "ios",
      toBundleId: "00000000-0000-0000-0000-000000000001",
      type: "UPDATE_APPLIED",
      updateStrategy: "appVersion",
    });
    const oversizedBody = new TextEncoder().encode(
      `${payload}${" ".repeat(17 * 1024)}`,
    );
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversizedBody);
          controller.close();
        },
      }),
      duplex: "half",
    };
    const response = await invokeHandler(
      `${HOT_UPDATER_BASE_PATH}/events`,
      init,
    );
    const persisted = await admin
      .firestore()
      .collection("bundle_events")
      .where("install_id", "==", "firebase-oversized-install")
      .get();

    expect(response.status).toBe(413);
    expect(persisted.empty).toBe(true);
  });

  it("exposes the managed Analytics route group by default", async () => {
    const versionResponse = await invokeHandler(
      `${HOT_UPDATER_BASE_PATH}/version`,
    );
    const queryResponse = await invokeHandler(
      `${HOT_UPDATER_BASE_PATH}/api/bundles/bundle-1/events/summary`,
    );

    await expect(versionResponse.json()).resolves.toMatchObject({
      capabilities: {
        eventIngestion: true,
        analyticsQueries: true,
      },
    });
    expect(queryResponse.status).toBe(200);
  });

  const protectedRoutes = [
    ["GET", "/version"],
    ["GET", `/fingerprint/ios/fingerprint/production/${NIL_UUID}/${NIL_UUID}`],
    [
      "GET",
      `/fingerprint/ios/fingerprint/production/${NIL_UUID}/${NIL_UUID}/cohort`,
    ],
    ["GET", `/app-version/ios/1.0/production/${NIL_UUID}/${NIL_UUID}`],
    ["GET", `/app-version/ios/1.0/production/${NIL_UUID}/${NIL_UUID}/cohort`],
    ["POST", "/events"],
    ["GET", "/api/bundles/bundle-1/events/summary"],
    ["GET", "/api/bundles/bundle-1/events/analytics"],
    ["GET", "/api/installations/overview"],
    ["GET", "/api/installations/active"],
    ["GET", "/api/installations"],
    ["GET", "/api/installations/install-1/events"],
  ] as const;

  it("denies a missing API key on every managed handler route", async () => {
    // Given: every route mounted by the managed Firebase handler.
    const requests = protectedRoutes.map(([method, routePath]) =>
      invokeHandler(`${HOT_UPDATER_BASE_PATH}${routePath}`, { method }, null),
    );

    // When: the client omits the managed API key.
    const responses = await Promise.all(requests);

    // Then: authentication rejects every route before its handler runs.
    expect(responses.map((response) => response.status)).toEqual(
      protectedRoutes.map(() => 401),
    );
  });

  it("denies an invalid API key on every managed handler route", async () => {
    // Given: every route mounted by the managed Firebase handler.
    const requests = protectedRoutes.map(([method, routePath]) =>
      invokeHandler(
        `${HOT_UPDATER_BASE_PATH}${routePath}`,
        { method },
        INVALID_API_KEY,
      ),
    );

    // When: the client sends a digest-mismatched key.
    const responses = await Promise.all(requests);

    // Then: authentication rejects every route before its handler runs.
    expect(responses.map((response) => response.status)).toEqual(
      protectedRoutes.map(() => 401),
    );
  });

  it("keeps the Firebase health endpoint public", async () => {
    // Given: the managed handler exposes a platform health endpoint.
    // When: the client calls it without an API key.
    const response = await invokeHandler("/ping", undefined, null);

    // Then: Firebase health checks continue to work.
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("pong");
  });

  it("does not support the legacy exact path", async () => {
    const response = await invokeHandler(HOT_UPDATER_BASE_PATH);

    expect(response.status).toBe(404);
  });

  it("does not expose management routes from the emulator entrypoint", async () => {
    const response = await invokeHandler(
      `${HOT_UPDATER_BASE_PATH}/api/bundles`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });
});

const clearFirestoreCollection = async (collectionName: string) => {
  const snapshot = await admin.firestore().collection(collectionName).get();

  if (snapshot.empty) {
    return;
  }

  const batch = admin.firestore().batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
};

const clearStorageBucket = async (storageBucket: string) => {
  const [files] = await admin.storage().bucket(storageBucket).getFiles();

  await Promise.all(
    files.map((file) =>
      file.delete().catch((error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === 404
        ) {
          return;
        }

        throw error;
      }),
    ),
  );
};

const seedStorageObject = async (
  storageBucket: string,
  key: string,
  body: string,
  contentType = "application/octet-stream",
) => {
  await admin
    .storage()
    .bucket(storageBucket)
    .file(key.replace(/^\/+/, ""))
    .save(body, {
      metadata: {
        contentType,
      },
    });
};

const seedCdnObject = (
  cdnObjects: Map<string, { body: string; contentType: string }>,
  key: string,
  body: string,
  contentType = "application/octet-stream",
) => {
  cdnObjects.set(key.replace(/^\/+/, ""), {
    body,
    contentType,
  });
};

const startFixtureCdn = async (
  port: number,
  cdnObjects: Map<string, { body: string; contentType: string }>,
) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const object = cdnObjects.get(key);

    if (!object) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    response.writeHead(200, { "content-type": object.contentType });
    response.end(object.body);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  return server;
};

const closeServer = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};
