import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingEnv: {} as Record<string, string>,
  events: [] as string[],
  existingProject: false,
  functionsDir: "",
  assertInfrastructure: vi.fn(),
  tmpDir: "",
}));

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return {
    ...actual,
    execa: vi.fn(async (command: string, args: readonly string[] = []) => {
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
      log: {
        ...actual.p.log,
        message: vi.fn(),
      },
      note: vi.fn(),
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

vi.mock("./firebaseInfrastructureState", () => ({
  assertFirebaseInfrastructureCanInitialize: mocks.assertInfrastructure,
}));

vi.mock("./prepareTemplate", () => ({
  prepareFirebaseTemplate: vi.fn(async () => ({
    functionsDir: mocks.functionsDir,
    removeTmpDir: async () => {
      mocks.events.push("cleanup");
    },
    tmpDir: mocks.tmpDir,
  })),
}));

vi.mock("./select", () => ({
  createFirebaseProject: vi.fn(async () => {
    mocks.events.push("create");
  }),
  initFirebaseUser: vi.fn(async () => {
    mocks.events.push("project");
    if (mocks.existingProject) {
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

import { p } from "@hot-updater/cli-tools";
import { execa } from "execa";

import { runInit } from "./index";
import { initFirebaseUser } from "./select";

describe("Firebase project creation", () => {
  beforeEach(async () => {
    mocks.existingEnv = {};
    mocks.events.length = 0;
    mocks.existingProject = false;
    mocks.assertInfrastructure.mockResolvedValue(undefined);
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
      JSON.stringify({ fieldOverrides: [], indexes: [] }),
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
  });

  it("points missing Firebase credentials to .env.hotupdater", async () => {
    // Given
    mocks.existingProject = true;
    mocks.existingEnv = {
      HOT_UPDATER_FIREBASE_PROJECT_ID: "existing-project",
      HOT_UPDATER_FIREBASE_REGION: "asia-northeast3",
    };

    // When
    await runInit({ build: "bare" });

    // Then
    expect(p.log.message).toHaveBeenCalledWith(
      "Next step: Change GOOGLE_APPLICATION_CREDENTIALS=your-credentials.json in .env.hotupdater",
    );
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("return null; // Replace with your app root"),
    );
  });

  it("blocks an existing v0 project before deployment", async () => {
    mocks.existingProject = true;
    mocks.assertInfrastructure.mockRejectedValueOnce(
      new Error("Firebase v0 infrastructure was detected"),
    );

    await expect(runInit({ build: "bare" })).rejects.toThrow(
      "Firebase v0 infrastructure was detected",
    );

    expect(mocks.events).toEqual(["project"]);
    expect(execa).toHaveBeenCalledOnce();
    expect(execa).toHaveBeenCalledWith("gcloud", ["--version"]);
  });
});
