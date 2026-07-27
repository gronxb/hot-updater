import { makeEnv, writeHotUpdaterConfig } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
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
        error: vi.fn(),
        info: vi.fn(),
        step: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
      },
      select: mocks.select,
      text: mocks.text,
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

import { createFirebaseProject, initFirebaseUser, setEnv } from "./select";

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
      if (invocation === "npx firebase projects:list --json") {
        return {
          stdout: JSON.stringify({ result: [] }),
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

  it("does not log in again when project discovery is already authenticated", async () => {
    // Given
    mocks.select.mockResolvedValue("demo-project");

    // When
    await initFirebaseUser("/tmp/firebase-init", undefined, false, undefined);

    // Then
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "npx",
      ["firebase", "login"],
      expect.anything(),
    );
  });

  it("logs in and retries when project discovery is unauthenticated", async () => {
    // Given
    let projectListAttempts = 0;
    mocks.execa.mockImplementation(async (command, args) => {
      const invocation = [command, ...args].join(" ");
      if (invocation === "gcloud auth list --format=json") {
        return { stdout: JSON.stringify([{ account: "user@example.com" }]) };
      }
      if (invocation === "npx firebase projects:list --json") {
        projectListAttempts++;
        if (projectListAttempts === 1) {
          throw new Error("Authentication required");
        }
        return {
          stdout: JSON.stringify({
            result: [{ displayName: "Demo", projectId: "demo-project" }],
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

    // When
    await initFirebaseUser("/tmp/firebase-init");

    // Then
    expect(mocks.execa).toHaveBeenCalledWith("npx", ["firebase", "login"], {
      env: undefined,
      stdio: "inherit",
    });
    expect(projectListAttempts).toBe(2);
  });

  it("prompts instead of replacing a missing saved project with a singleton", async () => {
    mocks.select.mockResolvedValue("demo-project");

    await initFirebaseUser("/tmp/firebase-init", "deleted-project", false, {});

    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a Firebase project",
      }),
    );
    expect(mocks.execa).toHaveBeenCalledWith(
      "npx",
      ["firebase", "use", "--add", "demo-project"],
      {
        cwd: "/tmp/firebase-init",
        env: {},
      },
    );
  });

  it("returns a creation plan without provisioning during input collection", async () => {
    mocks.select.mockImplementation(
      async ({ options }) =>
        options.find(
          (option: { label: string }) =>
            option.label === "Create new Firebase project",
        ).value,
    );
    mocks.text.mockResolvedValue("new-project");

    await expect(
      initFirebaseUser("/tmp/firebase-init", undefined, false, {}),
    ).resolves.toEqual({
      status: "create",
      projectId: "new-project",
    });
    expect(mocks.execa).not.toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["firebase", "projects:create"]),
      expect.anything(),
    );
    const [{ validate }] = mocks.text.mock.calls[0] as [
      {
        validate: (value: string) => string | undefined;
      },
    ];
    expect(validate("new-project")).toBeUndefined();
    expect(validate("--")).toMatch("Use 6-30 lowercase letters");
    expect(vi.mocked(makeEnv)).not.toHaveBeenCalled();
  });

  it("provisions a Firebase project only when the creation plan is applied", async () => {
    await createFirebaseProject({
      cliEnv: {},
      projectId: "new-project",
    });

    expect(mocks.execa).toHaveBeenCalledWith(
      "npx",
      [
        "firebase",
        "projects:create",
        "--display-name=new-project",
        "--non-interactive",
        "--",
        "new-project",
      ],
      {
        env: {},
        stdio: "inherit",
      },
    );
    expect(mocks.text).not.toHaveBeenCalled();
  });

  it.each(["--", "--display-name", "Uppercase-project", "short"])(
    "rejects an unsafe Firebase project ID before provisioning: %s",
    async (projectId) => {
      await expect(
        createFirebaseProject({
          cliEnv: {},
          projectId,
        }),
      ).rejects.toThrow(`Invalid Firebase project ID: ${projectId}`);

      expect(mocks.execa).not.toHaveBeenCalled();
    },
  );
});
