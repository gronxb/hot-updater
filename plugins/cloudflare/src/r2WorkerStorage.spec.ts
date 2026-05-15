import type { RequestEnvContext } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  type CloudflareWorkerStorageEnv,
  r2WorkerStorage,
} from "./r2WorkerStorage";

type TestContext = RequestEnvContext<CloudflareWorkerStorageEnv>;

describe("r2WorkerStorage", () => {
  it("reads manifest text directly from the R2 binding", async () => {
    const get = vi.fn(async (key: string) => ({
      text: async () => `text:${key}`,
    }));
    const storage = r2WorkerStorage({
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();

    await expect(
      storage.profiles.runtime.readText("r2://bundles/app/manifest.json", {
        env: {
          BUCKET: { get },
          JWT_SECRET: "secret",
        },
        request: new Request("https://updates.example.com"),
      } satisfies TestContext),
    ).resolves.toBe("text:app/manifest.json");
    expect(get).toHaveBeenCalledWith("app/manifest.json");
  });

  it("fails fast when the R2 binding is missing", async () => {
    const storage = r2WorkerStorage({
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();

    await expect(
      storage.profiles.runtime.readText("r2://bundles/app/manifest.json", {
        env: {
          JWT_SECRET: "secret",
        },
        request: new Request("https://updates.example.com"),
      } as TestContext),
    ).rejects.toThrow(
      "r2WorkerStorage requires env.BUCKET in the hot updater context.",
    );
  });
});
