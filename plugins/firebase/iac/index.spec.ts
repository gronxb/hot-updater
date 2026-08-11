import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingEnv: {} as Record<string, string>,
  events: [] as string[],
  existingProject: false,
  firebaseCredential: { source: "explicit-service-account" },
  firestoreIndexesStdout: "",
  functionsDir: "",
  generatedArtifacts: [] as Array<{
    componentId: string;
    contents: string;
    path: string;
    targetVersion: string;
  }>,
  tmpDir: "",
}));

vi.mock("../src/firebaseDatabase", () => ({
  firebaseDatabase: vi.fn(() => ({ name: "firebase-deployment-database" })),
}));

vi.mock("firebase-admin/app", () => ({
  cert: vi.fn(() => mocks.firebaseCredential),
}));

vi.mock("@hot-updater/server/db", () => ({
  generateUniversalComponentArtifacts: vi.fn(() => {
    mocks.events.push("generate-artifacts");
    return mocks.generatedArtifacts;
  }),
  migrateUniversalComponents: vi.fn(async () => {
    mocks.events.push("migrate-components");
    return [];
  }),
}));

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return {
    ...actual,
    execa: vi.fn(async (command: string, args: readonly string[] = []) => {
      if (command === "npx" && args.includes("firestore:indexes")) {
        return { stdout: mocks.firestoreIndexesStdout };
      }
      if (command === "npx" && args.includes("deploy")) {
        mocks.events.push(
          args.includes("firestore") ? "deploy-firestore" : "deploy-functions",
        );
        return { stdout: "" };
      }
      if (command === "npx" && args.includes("functions:list")) {
        return {
          stdout: JSON.stringify({
            result: [
              {
                id: "hot-updater",
                serviceAccount: "hot-updater@example.iam.gserviceaccount.com",
              },
            ],
          }),
        };
      }
      if (command === "gcloud" && args.includes("get-iam-policy")) {
        return {
          stdout: JSON.stringify({
            bindings: [
              {
                members: [
                  "serviceAccount:hot-updater@example.iam.gserviceaccount.com",
                ],
                role: "roles/iam.serviceAccountTokenCreator",
              },
            ],
          }),
        };
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
  };
});

vi.mock("@hot-updater/cli-tools", async () => {
  const actual = await vi.importActual<typeof import("@hot-updater/cli-tools")>(
    "@hot-updater/cli-tools",
  );
  return {
    ...actual,
    confirmInitInputPersistence: vi.fn(async () => {
      mocks.events.push("consent");
      return true;
    }),
    getInitProviderEnvVars: vi.fn(() => ({
      GOOGLE_APPLICATION_CREDENTIALS: "credentials.json",
      HOT_UPDATER_FIREBASE_PROJECT_ID: "new-project",
      HOT_UPDATER_FIREBASE_REGION: "asia-northeast3",
    })),
    makeEnv: vi.fn(async () => {
      mocks.events.push("persist");
      return "";
    }),
    p: {
      ...actual.p,
      text: vi.fn(async () => {
        mocks.events.push("credentials");
        return "credentials.json";
      }),
    },
    readHotUpdaterInitEnv: vi.fn(async () => ({
      env: mocks.existingEnv,
      managedEnv: {},
    })),
    resolveHotUpdaterServerVersion: vi.fn(() => "1.0.0"),
    resolvePackageVersion: vi.fn(() => "1.0.0"),
  };
});

vi.mock("./firebaseRegion", () => ({
  resolveFirebaseRegion: vi.fn(async () => {
    mocks.events.push("region");
    return "asia-northeast3";
  }),
}));

vi.mock("./prepareTemplate", async () => {
  const actual =
    await vi.importActual<typeof import("./prepareTemplate")>(
      "./prepareTemplate",
    );
  return {
    ...actual,
    materializeFirebaseComponentIndexArtifacts: vi.fn(
      actual.materializeFirebaseComponentIndexArtifacts,
    ),
    prepareFirebaseTemplate: vi.fn(async () => ({
      functionsDir: mocks.functionsDir,
      removeTmpDir: async () => {
        mocks.events.push("cleanup");
      },
      tmpDir: mocks.tmpDir,
    })),
  };
});

vi.mock("./select", () => ({
  createFirebaseProject: vi.fn(async () => {
    mocks.events.push("create");
  }),
  initFirebaseUser: vi.fn(async (...args: readonly unknown[]) => {
    mocks.events.push("project");
    if (mocks.existingProject) {
      const resolveCliEnv = args[4] as
        | ((projectId: string) => Promise<unknown>)
        | undefined;
      await resolveCliEnv?.("existing-project");
      return {
        projectId: "existing-project",
        status: "ready" as const,
        storageBucket: "existing-project.firebasestorage.app",
      };
    }
    return {
      projectId: "new-project",
      status: "create" as const,
    };
  }),
  setEnv: vi.fn(),
}));

import {
  generateUniversalComponentArtifacts,
  migrateUniversalComponents,
} from "@hot-updater/server/db";
import { execa } from "execa";
import { cert } from "firebase-admin/app";

import { firebaseDatabase } from "../src/firebaseDatabase";
import { runInit } from "./index";
import { initFirebaseUser } from "./select";

describe("Firebase project creation", () => {
  beforeEach(async () => {
    mocks.existingEnv = {};
    mocks.events.length = 0;
    mocks.existingProject = false;
    mocks.firestoreIndexesStdout = JSON.stringify({
      fieldOverrides: [],
      indexes: [],
    });
    mocks.generatedArtifacts = [];
    mocks.tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-firebase-init-"),
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
      JSON.stringify({
        fieldOverrides: [],
        indexes: [
          {
            collectionGroup: "core_records",
            fields: [{ fieldPath: "id", order: "ASCENDING" }],
            queryScope: "COLLECTION",
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(mocks.tmpDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("collects all inputs and consent before creating the project", async () => {
    await runInit({ build: "bare" });

    expect(mocks.events).toEqual([
      "project",
      "region",
      "consent",
      "create",
      "persist",
      "cleanup",
    ]);
  });

  it("deploys remote, core, and active component indexes before migration", async () => {
    mocks.existingProject = true;
    mocks.existingEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/firebase-credentials.json",
      HOT_UPDATER_FIREBASE_PROJECT_ID: "existing-project",
      HOT_UPDATER_FIREBASE_REGION: "asia-northeast3",
    };
    const artifact = {
      componentId: "audit-log",
      contents: JSON.stringify({
        fieldOverrides: [],
        indexes: [
          {
            collectionGroup: "component_records",
            fields: [
              { fieldPath: "recorded_at_ms", order: "ASCENDING" },
              { fieldPath: "id", order: "ASCENDING" },
            ],
            queryScope: "COLLECTION",
          },
        ],
      }),
      path: "firestore.indexes.audit-log.1.json",
      targetVersion: "1",
    } as const;
    mocks.generatedArtifacts = [artifact];
    mocks.firestoreIndexesStdout = JSON.stringify({
      fieldOverrides: [],
      indexes: [
        {
          collectionGroup: "remote_records",
          fields: [{ fieldPath: "created_at", order: "DESCENDING" }],
          queryScope: "COLLECTION",
        },
      ],
    });
    const target = { adapterName: "synthetic-deployment" };
    const createDeploymentTarget = vi.fn(() => target);

    await runInit({
      build: "bare",
      createDeploymentTarget,
      envFile: ".env.hotupdater",
    });

    expect(cert).toHaveBeenCalledWith(
      "/tmp/firebase-credentials.json",
    );
    expect(firebaseDatabase).toHaveBeenCalledWith({
      credential: mocks.firebaseCredential,
      projectId: "existing-project",
      storageBucket: "existing-project.firebasestorage.app",
    });
    expect(createDeploymentTarget).toHaveBeenCalledWith(
      vi.mocked(firebaseDatabase).mock.results[0]?.value,
    );
    expect(generateUniversalComponentArtifacts).toHaveBeenCalledWith(target);
    expect(migrateUniversalComponents).toHaveBeenCalledWith(target);
    const aggregate = JSON.parse(
      await fs.readFile(
        path.join(mocks.tmpDir, "firestore.indexes.json"),
        "utf8",
      ),
    ) as { indexes: Array<{ collectionGroup: string }> };
    expect(
      aggregate.indexes.map(({ collectionGroup }) => collectionGroup),
    ).toEqual(["component_records", "core_records", "remote_records"]);
    expect(mocks.events.indexOf("deploy-firestore")).toBeLessThan(
      mocks.events.indexOf("migrate-components"),
    );
    expect(mocks.events.indexOf("migrate-components")).toBeLessThan(
      mocks.events.indexOf("deploy-functions"),
    );
  });

  it("uses interactively selected credentials for the deployment database", async () => {
    mocks.existingProject = true;
    const createDeploymentTarget = vi.fn(() => ({
      adapterName: "synthetic-deployment",
    }));

    await runInit({ build: "bare", createDeploymentTarget });

    const credentialsPath = path.resolve("credentials.json");
    expect(cert).toHaveBeenCalledWith(credentialsPath);
    expect(firebaseDatabase).toHaveBeenCalledWith({
      credential: mocks.firebaseCredential,
      projectId: "existing-project",
      storageBucket: "existing-project.firebasestorage.app",
    });
  });

  it("fails closed when remote Firestore indexes are not JSON", async () => {
    mocks.existingProject = true;
    mocks.firestoreIndexesStdout = "Firebase CLI warning";

    await expect(runInit({ build: "bare" })).rejects.toThrow(
      "Cannot preserve remote Firestore indexes",
    );
    expect(mocks.events).not.toContain("deploy-firestore");
    expect(mocks.events).not.toContain("deploy-functions");
  });

  it("keeps application credentials out of interactive CLI authentication", async () => {
    mocks.existingEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/firebase-credentials.json",
    };

    await runInit({ build: "bare" });

    const initCall = vi.mocked(initFirebaseUser).mock.calls[0];
    expect(initCall?.[3]).toBeUndefined();

    const resolveCliEnv = initCall?.[4];
    expect(resolveCliEnv).toEqual(expect.any(Function));
    const selectedProjectCliEnv = await resolveCliEnv?.("new-project");
    expect(selectedProjectCliEnv).toBeUndefined();
  });

  it("uses active gcloud authentication when describing the deployed function", async () => {
    // Given
    mocks.existingProject = true;
    mocks.existingEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/firebase-credentials.json",
      HOT_UPDATER_FIREBASE_PROJECT_ID: "existing-project",
      HOT_UPDATER_FIREBASE_REGION: "asia-northeast3",
    };

    // When
    await runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    // Then
    expect(execa).toHaveBeenCalledWith(
      "gcloud",
      [
        "functions",
        "describe",
        "hot-updater",
        "--project",
        "existing-project",
        "--region",
        "asia-northeast3",
        "--format=json",
      ],
      {
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: "/tmp/firebase-credentials.json",
        },
      },
    );
    expect(generateUniversalComponentArtifacts).not.toHaveBeenCalled();
    expect(migrateUniversalComponents).not.toHaveBeenCalled();
    expect(firebaseDatabase).not.toHaveBeenCalled();
    expect(cert).not.toHaveBeenCalled();
  });
});
