import { describe, expect, it, vi } from "vitest";

import { makeEnv, writeHotUpdaterConfig } from "@hot-updater/cli-tools";

import { setEnv } from "./select";

vi.mock("@hot-updater/cli-tools", async () => {
  const actual =
    await vi.importActual<typeof import("@hot-updater/cli-tools")>(
      "@hot-updater/cli-tools",
    );

  return {
    ...actual,
    createHotUpdaterConfigScaffold: vi.fn().mockReturnValue({}),
    makeEnv: vi.fn().mockResolvedValue(""),
    p: {
      log: {
        success: vi.fn(),
        warn: vi.fn(),
      },
    },
    writeHotUpdaterConfig: vi.fn().mockResolvedValue({
      status: "created",
      path: "hot-updater.config.ts",
    }),
  };
});

describe("setEnv", () => {
  it("preserves GOOGLE_APPLICATION_CREDENTIALS when updating Firebase env vars", async () => {
    await setEnv({
      projectId: "demo-project",
      storageBucket: "demo-bucket",
      build: "bare",
    });

    expect(vi.mocked(makeEnv)).toHaveBeenCalledWith(
      {
        GOOGLE_APPLICATION_CREDENTIALS: {
          comment:
            "Project Settings > Service Accounts > New Private Key > Download JSON",
          value: "your-credentials.json",
        },
        HOT_UPDATER_FIREBASE_PROJECT_ID: "demo-project",
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
