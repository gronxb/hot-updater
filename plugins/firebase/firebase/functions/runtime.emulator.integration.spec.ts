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

import { transformEnv } from "@hot-updater/cli-tools";
import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server/runtime";
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

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    storageUri: `gs://hot-updater-test/${bundle.id}/bundle.zip`,
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
  const projectId = process.env.GCLOUD_PROJECT ?? "";
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST ?? "";

  beforeAll(async () => {
    if (!projectId || !firestoreHost) {
      throw new Error(
        "Firebase acceptance tests require FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT.",
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
          REGION,
        },
      ),
    );

    const firebaseAdminApp = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ projectId });
    const adminOptions = firebaseAdminApp.options;

    seedHotUpdater = createHotUpdater({
      database: firebaseDatabase(adminOptions),
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
    await clearFirestoreCollection("bundles");
    await clearFirestoreCollection("channels");
    await clearFirestoreCollection("target_app_versions");
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
    headers?: Headers | Record<string, string>,
  ) => {
    return await fetch(
      `http://127.0.0.1:${functionsPort}/${projectId}/${REGION}/${FUNCTION_NAME}${routePath}`,
      {
        headers,
      },
    );
  };

  const seedRuntimeBundles = async (bundles: Bundle[]) => {
    for (const bundle of bundles.map(toRuntimeBundle)) {
      await seedHotUpdater.insertBundle(bundle);
    }
  };

  const requestUpdateInfo = async (args: GetBundlesArgs) => {
    const response = await invokeHandler(createCanonicalPath(args));

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
        seedCdnObject(
          cdnObjects,
          `${fixture.nextBundleId}/manifest.json`,
          JSON.stringify(fixture.nextManifest),
          "application/json",
        );

        return {
          currentMetadata: {
            asset_base_storage_uri: `gs://hot-updater-test/${fixture.currentBundleId}/files`,
            manifest_file_hash: "sig:manifest-current",
            manifest_storage_uri: `gs://hot-updater-test/${fixture.currentBundleId}/manifest.json`,
          },
          nextMetadata: {
            asset_base_storage_uri: `gs://hot-updater-test/${fixture.nextBundleId}/files`,
            manifest_file_hash: "sig:manifest-next",
            manifest_storage_uri: `gs://hot-updater-test/${fixture.nextBundleId}/manifest.json`,
          },
        };
      },
      expectFileUrl: (fileUrl, fixture) => {
        expect(fileUrl).toBe(
          `${cdnBaseUrl}/${fixture.nextBundleId}/files/${fixture.changedAssetPath}`,
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
      seedCdnObject(
        cdnObjects,
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
        currentMetadata: {
          asset_base_storage_uri: `gs://hot-updater-test/${fixture.currentBundleId}/files`,
          manifest_file_hash: "sig:manifest-current",
          manifest_storage_uri: `gs://hot-updater-test/${fixture.currentBundleId}/manifest.json`,
        },
        nextMetadata: {
          asset_base_storage_uri: `gs://hot-updater-test/${fixture.nextBundleId}/files`,
          diff_base_bundle_id: fixture.currentBundleId,
          hbc_patch_algorithm: "bsdiff",
          hbc_patch_asset_path: fixture.assetPath,
          hbc_patch_base_file_hash: "hash-old-bundle",
          hbc_patch_file_hash: "hash-bsdiff",
          hbc_patch_storage_uri: `gs://hot-updater-test/${fixture.patchPath}`,
          manifest_file_hash: "sig:manifest-next",
          manifest_storage_uri: `gs://hot-updater-test/${fixture.nextBundleId}/manifest.json`,
        },
      };
    },
    expectPatchUrl: (patchUrl, fixture) => {
      expect(patchUrl).toBe(`${cdnBaseUrl}/${fixture.patchPath}`);
    },
  });

  it("serves canonical routes from the emulator entrypoint", async () => {
    await seedHotUpdater.insertBundle(
      toRuntimeBundle({
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
      }),
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
