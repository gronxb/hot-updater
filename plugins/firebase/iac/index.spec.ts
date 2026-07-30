import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existingEnv: {} as Record<string, string>,
  events: [] as string[],
  functionsDir: "",
  tmpDir: "",
}));

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return {
    ...actual,
    execa: vi.fn().mockResolvedValue({ stdout: "" }),
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
    return {
      status: "create",
      projectId: "new-project",
    };
  }),
  setEnv: vi.fn(),
}));

import { runInit } from "./index";
import { initFirebaseUser } from "./select";

describe("Firebase project creation", () => {
  beforeEach(async () => {
    mocks.existingEnv = {};
    mocks.events.length = 0;
    mocks.tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-firebase-init-"),
    );
    mocks.functionsDir = path.join(mocks.tmpDir, "functions");
    await fs.mkdir(mocks.functionsDir);
    await fs.writeFile(
      path.join(mocks.functionsDir, "package.json"),
      JSON.stringify({ dependencies: {} }),
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
});
