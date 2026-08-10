import {
  access,
  chmod,
  cp,
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

import { registerManagedAccessKey } from "@hot-updater/better-auth/managed";
import { transformEnv } from "@hot-updater/cli-tools";
import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { createManagedServerPlugins } from "@hot-updater/managed";
import { createHotUpdater } from "@hot-updater/server";
import {
  generateUniversalComponentArtifacts,
  migrateUniversalComponents,
  type UniversalComponentGeneratedArtifact,
  type UniversalComponentMigrationSummary,
} from "@hot-updater/server/db";
import {
  setupBsdiffManifestUpdateInfoTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertCommandAvailable,
  findOpenPort,
  spawnRuntime,
  stopRuntime,
  waitForHttpOk,
} from "../../../../packages/test-utils/src/runtimeProcess";
import { mergeFirebaseComponentIndexArtifacts } from "../../src/firebaseComponentIndexArtifacts";
import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseFunctionsStorage } from "../../src/firebaseFunctionsStorage";
import { createFirebaseManagedAccessKeyStore } from "../../src/firebaseManagedAccessKeyStore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../..");
const REGION = "us-central1";
const FUNCTION_NAME = "hot-updater";
const HOT_UPDATER_BASE_PATH = "/api/check-update";
const RAW_API_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WRONG_API_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
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

describe.sequential("firebase functions runtime acceptance", () => {
  const cdnObjects = new Map<string, { body: string; contentType: string }>();
  let cdnBaseUrl = "";
  let cdnServer: Server | undefined;
  let tempRoot: string | undefined;
  let functionsPort = 0;
  let functionsRuntime: ReturnType<typeof spawnRuntime> | undefined;
  let seedHotUpdater: ReturnType<typeof createHotUpdater>;
  let componentArtifacts: readonly UniversalComponentGeneratedArtifact[] = [];
  let componentMigrations: readonly UniversalComponentMigrationSummary[] = [];
  let stagedFirestoreIndexes = "";
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
    const functionsDir = path.join(tempRoot, "functions");
    await mkdir(functionsDir, { recursive: true });
    await cp(
      path.join(WORKSPACE_ROOT, "plugins/firebase/dist/firebase/functions"),
      functionsDir,
      { recursive: true },
    );
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
          REGION,
        },
      ),
    );

    const firebaseAdminApp =
      getApps()[0] ?? initializeApp({ projectId, storageBucket });
    const adminOptions = {
      ...firebaseAdminApp.options,
      projectId,
      storageBucket,
    };
    const database = firebaseDatabase(adminOptions);
    const deploymentTarget = createHotUpdater({
      database,
      plugins: createManagedServerPlugins(),
    });
    componentArtifacts = generateUniversalComponentArtifacts(deploymentTarget);
    stagedFirestoreIndexes = mergeFirebaseComponentIndexArtifacts(
      await readFile(
        path.join(
          WORKSPACE_ROOT,
          "plugins/firebase/dist/firebase/public/firestore.indexes.json",
        ),
        "utf8",
      ),
      componentArtifacts,
    );
    await writeFile(
      path.join(tempRoot, "firestore.indexes.json"),
      stagedFirestoreIndexes,
    );
    componentMigrations = await migrateUniversalComponents(deploymentTarget);
    await registerManagedAccessKey({
      apiKey: RAW_API_KEY,
      createdAt: 1,
      name: "Runtime test",
      store: createFirebaseManagedAccessKeyStore(
        admin.firestore(firebaseAdminApp),
      ),
    });

    seedHotUpdater = createHotUpdater({
      database,
      storages: [
        firebaseFunctionsStorage({
          ...adminOptions,
          cdnUrl: cdnBaseUrl,
        }),
      ],
      basePath: HOT_UPDATER_BASE_PATH,
      routes: {
        updateCheck: true,
        bundles: false,
      },
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
    await clearFirestoreCollection("bundle_patches");
    await clearFirestoreCollection("bundles");
    await clearFirestoreCollection("bundle_events");
  });

  it("generates and migrates components declared by the managed runtime", async () => {
    expect(componentArtifacts).toEqual([
      expect.objectContaining({
        componentId: "analytics",
        path: "firestore.indexes.analytics.2.json",
        targetVersion: "2",
      }),
    ]);
    expect(componentMigrations).toEqual([
      {
        changed: true,
        componentId: "analytics",
        version: "2",
      },
    ]);
    expect(
      (
        JSON.parse(stagedFirestoreIndexes) as {
          readonly indexes: readonly unknown[];
        }
      ).indexes,
    ).toContainEqual({
      collectionGroup: "bundle_events",
      fields: [
        { fieldPath: "received_at_ms", order: "ASCENDING" },
        { fieldPath: "id", order: "ASCENDING" },
      ],
      queryScope: "COLLECTION",
    });
    await expect(
      admin
        .firestore()
        .collection("private_hot_updater_settings")
        .doc("schema.analytics")
        .get()
        .then((snapshot) => snapshot.data()),
    ).resolves.toEqual({ value: "2" });
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

  const invokeHandler = async (routePath: string, init?: RequestInit) => {
    return await fetch(
      `http://127.0.0.1:${functionsPort}/${projectId}/${REGION}/${FUNCTION_NAME}${routePath}`,
      init,
    );
  };

  it("keeps version public and requires the client key for event ingestion", async () => {
    const version = await invokeHandler(`${HOT_UPDATER_BASE_PATH}/version`, {
      headers: { "x-api-key": WRONG_API_KEY },
    });
    const rejectedEvent = await invokeHandler(
      `${HOT_UPDATER_BASE_PATH}/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": WRONG_API_KEY,
        },
        body: JSON.stringify({
          type: "UNCHANGED",
          installId: "firebase-managed-install",
          toBundleId: "bundle-1",
          platform: "ios",
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: null,
          updateStrategy: null,
        }),
      },
    );
    const event = await invokeHandler(`${HOT_UPDATER_BASE_PATH}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": RAW_API_KEY,
      },
      body: JSON.stringify({
        type: "UNCHANGED",
        installId: "firebase-managed-install",
        toBundleId: "bundle-1",
        platform: "ios",
        appVersion: "1.0.0",
        channel: "production",
        cohort: "default",
        fingerprintHash: null,
        fromBundleId: null,
        updateStrategy: null,
      }),
    });
    const persisted = await admin
      .firestore()
      .collection("bundle_events")
      .where("install_id", "==", "firebase-managed-install")
      .get();

    expect(version.status).toBe(200);
    expect(rejectedEvent.status).toBe(401);
    expect(event.status).toBe(204);
    expect(persisted.size).toBe(1);
  });

  it("protects only Analytics query routes", async () => {
    const queryPaths = [
      "/api/bundles/bundle-1/events/summary",
      "/api/bundles/bundle-1/events/analytics",
      "/api/installations/overview",
      "/api/installations/active",
      "/api/installations?query=install",
      "/api/installations/install-1/events",
    ];

    for (const path of queryPaths) {
      for (const apiKey of [undefined, WRONG_API_KEY]) {
        const response = await invokeHandler(
          `${HOT_UPDATER_BASE_PATH}${path}`,
          apiKey === undefined
            ? undefined
            : { headers: { "x-api-key": apiKey } },
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        await expect(response.json()).resolves.toEqual({
          error: "Unauthorized",
        });
      }

      const clientKeyResponse = await invokeHandler(
        `${HOT_UPDATER_BASE_PATH}${path}`,
        { headers: { "x-api-key": RAW_API_KEY } },
      );
      expect(clientKeyResponse.status).toBe(401);
    }
  });

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
    const response = await invokeHandler(createCanonicalPath(args), {
      headers: { "x-api-key": RAW_API_KEY },
    });

    return (await response.json()) as any;
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
      { headers: { "x-api-key": RAW_API_KEY } },
    );

    await expect(response.json()).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
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
  const firestore = getFirestore();
  const snapshot = await firestore.collection(collectionName).get();

  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
  }
  await batch.commit();
};

const clearStorageBucket = async (storageBucket: string) => {
  const [files] = await getStorage().bucket(storageBucket).getFiles();

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
  await getStorage()
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
