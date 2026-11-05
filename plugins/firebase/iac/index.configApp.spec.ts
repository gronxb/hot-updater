import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type App,
  type AppOptions,
  applicationDefault,
  deleteApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingEnv: {} as Record<string, string>,
  firestoreAppOptions: [] as AppOptions[],
  functionsDir: "",
  tmpDir: "",
}));

// The options of the app each Firestore handle opens on; nothing reaches
// Firestore.
vi.mock("firebase-admin/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("firebase-admin/firestore")>()),
  getFirestore: vi.fn((app: App) => {
    mocks.firestoreAppOptions.push(app.options);
    return { collection: () => ({ doc: () => ({}) }) };
  }),
}));

vi.mock("../src/firebaseDatabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/firebaseDatabase")>()),
  migrateFirebaseDatabase: vi.fn(),
}));

vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: vi.fn(async (command: string, args: readonly string[] = []) => {
    if (command === "npx" && args.includes("functions:list")) {
      return {
        stdout: JSON.stringify({
          result: [
            {
              id: "hot-updater-v1",
              serviceAccount: "hot-updater@example.iam.gserviceaccount.com",
              uri: "https://hot-updater.example.com",
            },
          ],
        }),
      };
    }
    if (command === "gcloud" && args.includes("get-iam-policy")) {
      return { stdout: JSON.stringify({ bindings: [] }) };
    }
    if (command === "gcloud" && args.includes("describe")) {
      return {
        stdout: JSON.stringify({
          serviceConfig: { uri: "https://hot-updater.example.com" },
        }),
      };
    }
    return { stdout: "" };
  }),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    confirmInitInputPersistence: vi.fn(async () => true),
    makeEnv: vi.fn(async () => ""),
    printAppSetup: vi.fn(),
    provisionClientCredential: vi.fn(async () => undefined),
    readHotUpdaterInitEnv: vi.fn(async () => ({
      env: mocks.existingEnv,
      managedEnv: {},
    })),
    resolveHotUpdaterServerVersion: vi.fn(() => "1.0.0"),
    resolvePackageVersion: vi.fn(() => "1.0.0"),
  };
});

vi.mock("./firebaseRegion", () => ({
  resolveFirebaseRegion: vi.fn(async () => "asia-northeast3"),
}));

vi.mock("./firebaseInfrastructureState", () => ({
  assertFirebaseFunctionCanInitialize: vi.fn(),
  assertFirebaseInfrastructureCanInitialize: vi.fn(),
}));

vi.mock("./prepareTemplate", () => ({
  prepareFirebaseTemplate: vi.fn(async () => ({
    functionsDir: mocks.functionsDir,
    removeTmpDir: async () => {},
    tmpDir: mocks.tmpDir,
  })),
}));

vi.mock("./select", () => ({
  createFirebaseProject: vi.fn(),
  initFirebaseUser: vi.fn(async () => ({
    databaseId: "(default)",
    projectId: "init-project",
    status: "ready" as const,
    storageBucket: "init-project.firebasestorage.app",
  })),
  setEnv: vi.fn(),
}));

import { runInit } from "./index";

const CLIENT_EMAIL = "init@init-project.iam.gserviceaccount.com";

describe("Firebase init after hot-updater.config.ts was loaded", () => {
  const credentialsVariable = process.env["GOOGLE_APPLICATION_CREDENTIALS"];

  beforeEach(async () => {
    mocks.firestoreAppOptions.length = 0;
    mocks.tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-firebase-config-app-"),
    );
    mocks.functionsDir = path.join(mocks.tmpDir, "functions");
    await fs.mkdir(mocks.functionsDir);
    await fs.writeFile(
      path.join(mocks.functionsDir, "package.json"),
      JSON.stringify({ dependencies: {} }),
    );
    await fs.writeFile(path.join(mocks.functionsDir, "index.cjs"), "");
    await fs.writeFile(
      path.join(mocks.tmpDir, "firestore.indexes.json"),
      JSON.stringify({ fieldOverrides: [], indexes: [] }),
    );
    await fs.writeFile(
      path.join(mocks.tmpDir, "firebase.json"),
      JSON.stringify({ firestore: { indexes: "firestore.indexes.json" } }),
    );
    const credentialsPath = path.join(mocks.tmpDir, "service-account.json");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await fs.writeFile(
      credentialsPath,
      JSON.stringify({
        type: "service_account",
        project_id: "init-project",
        private_key: privateKey.export({ format: "pem", type: "pkcs8" }),
        client_email: CLIENT_EMAIL,
      }),
    );
    // The env file is the only place that names the service account.
    delete process.env["GOOGLE_APPLICATION_CREDENTIALS"];
    mocks.existingEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
      HOT_UPDATER_FIREBASE_PROJECT_ID: "init-project",
      HOT_UPDATER_FIREBASE_REGION: "asia-northeast3",
    };
  });

  afterEach(async () => {
    if (credentialsVariable === undefined) {
      delete process.env["GOOGLE_APPLICATION_CREDENTIALS"];
    } else {
      process.env["GOOGLE_APPLICATION_CREDENTIALS"] = credentialsVariable;
    }
    await Promise.all(getApps().map((app) => deleteApp(app)));
    await fs.rm(mocks.tmpDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("migrates with the env file's service account, not the default app the config bound", async () => {
    // Loading the config for its secrets adapter ran firebaseStorage(), which
    // bound the default app to Application Default Credentials, and then
    // restored the environment the config's loadEnvFile had set.
    initializeApp({
      credential: applicationDefault(),
      projectId: "config-project",
    });

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(mocks.firestoreAppOptions).not.toHaveLength(0);
    for (const options of mocks.firestoreAppOptions) {
      expect(options.projectId).toBe("init-project");
      expect(options.credential).toMatchObject({ clientEmail: CLIENT_EMAIL });
    }
  });
});
