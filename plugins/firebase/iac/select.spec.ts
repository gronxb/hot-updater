import { makeEnv, writeHotUpdaterConfig } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  select: vi.fn(),
}));

vi.mock("execa", async () => {
  const actual = await vi.importActual<typeof import("execa")>("execa");
  return {
    ...actual,
    execa: mocks.execa,
  };
});

vi.mock("@hot-updater/cli-tools", async () => {
  const actual = await vi.importActual<typeof import("@hot-updater/cli-tools")>(
    "@hot-updater/cli-tools",
  );

  return {
    ...actual,
    createHotUpdaterConfigScaffold: vi.fn().mockReturnValue({}),
    createHotUpdaterConfigScaffoldFromBuilder: vi.fn().mockReturnValue({}),
    makeEnv: vi.fn().mockResolvedValue(""),
    p: {
      ...actual.p,
      log: {
        success: vi.fn(),
        warn: vi.fn(),
      },
      select: mocks.select,
      tasks: vi.fn(async (tasks) => {
        for (const task of tasks) {
          await task.task(vi.fn());
        }
      }),
    },
    writeHotUpdaterConfig: vi.fn().mockResolvedValue({
      status: "created",
      path: "hot-updater.config.ts",
    }),
  };
});

import { initFirebaseUser, setEnv } from "./select";

describe("setEnv", () => {
  it("preserves GOOGLE_APPLICATION_CREDENTIALS when updating Firebase env vars", async () => {
    await setEnv({
      projectId: "demo-project",
      storageBucket: "demo-bucket",
      build: "bare",
      region: "asia-northeast3",
    });

    expect(vi.mocked(makeEnv)).toHaveBeenCalledWith(
      {
        GOOGLE_APPLICATION_CREDENTIALS: {
          comment:
            "Project Settings > Service Accounts > New Private Key > Download JSON",
          value: "your-credentials.json",
        },
        HOT_UPDATER_FIREBASE_PROJECT_ID: "demo-project",
        HOT_UPDATER_FIREBASE_REGION: "asia-northeast3",
        HOT_UPDATER_FIREBASE_STORAGE_BUCKET: "demo-bucket",
      },
      ".env.hotupdater",
      {
        preserveKeys: ["GOOGLE_APPLICATION_CREDENTIALS"],
      },
    );
    expect(vi.mocked(writeHotUpdaterConfig)).toHaveBeenCalledOnce();
  });
});

describe("initFirebaseUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execa.mockImplementation(async (command, args) => {
      const invocation = [command, ...args].join(" ");

      if (invocation === "gcloud auth list --format=json") {
        return { stdout: JSON.stringify([{ account: "user@example.com" }]) };
      }
      if (
        invocation === "npx firebase projects:list --json --non-interactive"
      ) {
        return {
          stdout: JSON.stringify({
            result: [
              {
                projectId: "demo-project",
                displayName: "Demo",
              },
            ],
          }),
        };
      }
      if (
        invocation ===
        "gcloud firestore databases list --project=demo-project --format=json"
      ) {
        return { stdout: JSON.stringify([{ name: "(default)" }]) };
      }
      if (
        invocation ===
        "gcloud storage buckets list --project=demo-project --format=json"
      ) {
        return {
          stdout: JSON.stringify([
            { name: "demo-project.firebasestorage.app" },
          ]),
        };
      }
      if (
        invocation === "gcloud projects describe demo-project --format=json"
      ) {
        return { stdout: JSON.stringify({ projectNumber: "123" }) };
      }

      return { stdout: "" };
    });
  });

  it("uses the saved project without login or selection in non-interactive mode", async () => {
    await initFirebaseUser("/tmp/firebase-init", "demo-project", true);

    expect(mocks.execa).toHaveBeenCalledWith(
      "npx",
      ["firebase", "use", "demo-project", "--non-interactive"],
      {
        cwd: "/tmp/firebase-init",
      },
    );
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "npx",
      ["firebase", "login"],
      expect.anything(),
    );
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "gcloud",
      ["auth", "login"],
      expect.anything(),
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(vi.mocked(makeEnv)).not.toHaveBeenCalled();
  });
});
