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
import type { LegacyBundle as Bundle } from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server";
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
import { firebaseDatabase } from "../../src/firebaseDatabase";
import { firebaseStorage } from "../../src/firebaseStorage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../..");
const REGION = "us-central1";
const FUNCTION_NAME = "hot-updater";
const HOT_UPDATER_BASE_PATH = "/";
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
          AUTHORITY_ID: projectId,
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

    seedHotUpdater = createHotUpdater({
      authorityId: projectId,
      database: firebaseDatabase({ ...adminOptions, authorityId: projectId }),
      storage: [
        firebaseStorage({
          ...adminOptions,
          cdnUrl: cdnBaseUrl,
        }),
      ],
      basePath: HOT_UPDATER_BASE_PATH,
      features: {
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
    await clearFirestoreCollection("release_catalogs");
    await clearFirestoreCollection("releases");
    await clearFirestoreCollection("bundles");
    await clearFirestoreCollection("channels");
    await clearFirestoreCollection("private_hot_updater_settings", (id) =>
      id.startsWith("channel_id_"),
    );
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

  it("serves v1 Release Catalog routes from the emulator entrypoint", async () => {
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
      `/v2/release-catalogs/app-version/${encodeURIComponent(projectId)}/ios/cHJvZHVjdGlvbg/1.0.0`,
    );

    await expect(response.json()).resolves.toMatchObject({
      releases: [{ bundleId: "00000000-0000-0000-0000-000000000001" }],
    });
  });

  it("does not support the legacy exact path", async () => {
    const response = await invokeHandler("/api/check-update");

    expect(response.status).toBe(404);
  });

  it("does not expose management routes from the emulator entrypoint", async () => {
    const response = await invokeHandler("/api/bundles");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });
});

const clearFirestoreCollection = async (
  collectionName: string,
  matches: (id: string) => boolean = () => true,
) => {
  const firestore = getFirestore();
  const snapshot = await firestore.collection(collectionName).get();

  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  for (const doc of snapshot.docs) {
    if (matches(doc.id)) batch.delete(doc.ref);
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
