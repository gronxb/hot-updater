import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformEnv } from "@hot-updater/cli-tools";
import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server/runtime";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import admin from "firebase-admin";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findOpenPort,
  hasCommand,
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
const FUNCTION_NAME = "handler";
const CDN_URL = "https://cdn.example.com";
const HOT_UPDATER_BASE_PATH = "/api/check-update";
const hasFirebaseCli = hasCommand("pnpm", [
  "--filter",
  "@hot-updater/firebase",
  "exec",
  "firebase",
  "--version",
]);
const describeIfFirebaseCli = hasFirebaseCli
  ? describe.sequential
  : describe.skip;
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

const createLegacyHeaders = (args: GetBundlesArgs) => {
  const headers = new Headers({
    "x-app-platform": args.platform,
    "x-bundle-id": args.bundleId,
  });

  if (args.channel) {
    headers.set("x-channel", args.channel);
  }

  if (args.minBundleId) {
    headers.set("x-min-bundle-id", args.minBundleId);
  }

  if (args.cohort) {
    headers.set("x-cohort", args.cohort);
  }

  if (args._updateStrategy === "appVersion") {
    headers.set("x-app-version", args.appVersion);
  } else {
    headers.set("x-fingerprint-hash", args.fingerprintHash);
  }

  return headers;
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

describeIfFirebaseCli("firebase functions runtime acceptance", () => {
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
          cdnUrl: CDN_URL,
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
        HOT_UPDATER_CDN_URL: CDN_URL,
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

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    for (const bundle of bundles.map(toRuntimeBundle)) {
      await seedHotUpdater.insertBundle(bundle);
    }

    const response = await invokeHandler(
      HOT_UPDATER_BASE_PATH,
      createLegacyHeaders(args),
    );

    return (await response.json()) as any;
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

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

  it("returns rewrite validation errors from the emulator entrypoint", async () => {
    const response = await invokeHandler(HOT_UPDATER_BASE_PATH, {
      "x-app-platform": "ios",
      "x-app-version": "1.0.0",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing required headers (x-app-platform, x-bundle-id).",
    });
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
