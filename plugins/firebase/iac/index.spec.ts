import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingEnv: {} as Record<string, string>,
  events: [] as string[],
  existingProject: false,
  functionsListError: undefined as Error | undefined,
  functionsDir: "",
  assertFunction: vi.fn(),
  assertInfrastructure: vi.fn(),
  provisionApiKey: vi.fn(async () => ({
    apiKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  })),
  serviceEnableError: undefined as Error | undefined,
  tmpDir: "",
}));

vi.mock("@hot-updater/server", async () => {
  const actual = await vi.importActual<typeof import("@hot-updater/server")>(
    "@hot-updater/server",
  );
  return {
    ...actual,
    provisionApiKey: mocks.provisionApiKey,
  };
});

vi.mock("../src/firebaseDatabase", () => ({
  firebaseDatabase: vi.fn(() => ({
    models: { apiKeys: {} },
  })),
}));

vi.mock("firebase-admin/app", async () => {
  const actual =
    await vi.importActual<typeof import("firebase-admin/app")>(
      "firebase-admin/app",
    );
  return {
    ...actual,
    applicationDefault: vi.fn(() => ({})),
    cert: vi.fn(() => ({})),
    deleteApp: vi.fn(),
    getApps: vi.fn(() => []),
  };
});

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return {
    ...actual,
    execa: vi.fn(async (command: string, args: readonly string[] = []) => {
      if (command === "npx" && args.includes("functions:list")) {
        if (mocks.functionsListError) throw mocks.functionsListError;
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
      if (command === "gcloud" && args.includes("services")) {
        if (mocks.serviceEnableError) throw mocks.serviceEnableError;
        return { stdout: "" };
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
  assertFirebaseFunctionCanInitialize: mocks.assertFunction,
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

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

describe("Firebase project creation", () => {
  beforeEach(async () => {
    mocks.existingEnv = {};
    mocks.events.length = 0;
    mocks.existingProject = false;
    mocks.functionsListError = undefined;
    mocks.serviceEnableError = undefined;
    mocks.assertFunction.mockResolvedValue(undefined);
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
    const credentialsPath = path.join(mocks.tmpDir, "credentials.json");
    await fs.writeFile(credentialsPath, "{}");
    mocks.existingEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
      HOT_UPDATER_API_KEY: API_KEY,
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
        "hot-updater-v1",
        "--project",
        "existing-project",
        "--region",
        "asia-northeast3",
        "--format=json",
      ],
      {
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
        },
      },
    );
    expect(mocks.provisionApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ existingApiKey: API_KEY }),
    );
    expect(execa).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining([
        "firebase",
        "deploy",
        "--only",
        "functions:hot-updater-v1",
      ]),
      expect.objectContaining({ cwd: mocks.tmpDir }),
    );
    expect(execa).not.toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["firebase", "deploy", "--only", "functions"]),
      expect.anything(),
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
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining(`"x-api-key": "${API_KEY}"`),
    );
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("HotUpdater.checkForUpdate"),
    );
    expect(p.note).toHaveBeenCalledWith(API_KEY, "API Key");
    expect(p.log.message).toHaveBeenCalledWith(
      "Store this API key separately in a secure place.",
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

  it("blocks an incompatible function occupying the v1 name", async () => {
    mocks.existingProject = true;
    mocks.assertFunction.mockRejectedValueOnce(
      new Error(
        "Firebase v0 infrastructure was detected at Function hot-updater-v1",
      ),
    );

    await expect(runInit({ build: "bare" })).rejects.toThrow(
      "Firebase v0 infrastructure was detected at Function hot-updater-v1",
    );

    expect(mocks.events).toEqual(["project"]);
    expect(execa).toHaveBeenCalledWith(
      "gcloud",
      [
        "services",
        "enable",
        "cloudfunctions.googleapis.com",
        "--project=existing-project",
        "--quiet",
      ],
      { env: undefined },
    );
    expect(execa).toHaveBeenCalledWith(
      "npx",
      ["firebase", "functions:list", "--json", "--project", "existing-project"],
      { cwd: mocks.tmpDir, env: undefined },
    );
    const serviceEnableCall = vi
      .mocked(execa)
      .mock.calls.findIndex(
        ([, args]) => Array.isArray(args) && args.includes("services"),
      );
    const functionsListCall = vi
      .mocked(execa)
      .mock.calls.findIndex(
        ([, args]) => Array.isArray(args) && args.includes("functions:list"),
      );
    expect(serviceEnableCall).toBeLessThan(functionsListCall);
    expect(mocks.assertFunction).toHaveBeenCalledWith({
      functions: expect.arrayContaining([
        expect.objectContaining({ id: "hot-updater-v1" }),
      ]),
    });
    expect(mocks.provisionApiKey).not.toHaveBeenCalled();
  });

  it("reports an actionable error when Firebase still cannot list functions", async () => {
    mocks.existingProject = true;
    mocks.functionsListError = new Error("Failed to list functions");

    await expect(runInit({ build: "bare" })).rejects.toThrow(
      "Could not list Firebase Functions for project existing-project: Failed to list functions. Run npx firebase functions:list --project existing-project --debug for details.",
    );

    expect(mocks.assertFunction).not.toHaveBeenCalled();
    expect(mocks.provisionApiKey).not.toHaveBeenCalled();
  });
});
