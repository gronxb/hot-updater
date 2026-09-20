import { createStoragePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { downloadBundle } from "./downloadBundle";

const createDatabaseClient = (manifestStorageUri: string) =>
  ({
    getBundleById: vi.fn(async () => ({
      id: "bundle-id",
      manifestStorageUri,
    })),
  }) as never;

describe("downloadBundle", () => {
  it("redirects already-public storage without requiring a plugin URL API", async () => {
    const response = await downloadBundle("bundle-id", {
      databaseClient: createDatabaseClient(
        "https://cdn.example.com/manifest.json",
      ),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://cdn.example.com/manifest.json",
    );
  });

  it("streams a custom storage Response through the Console route", async () => {
    const get = vi.fn(async () => ({
      response: new Response("manifest", {
        headers: { "content-type": "application/json" },
      }),
    }));
    const storagePlugin = createStoragePlugin({
      name: "r2Storage",
      protocol: "r2",
      get,
    });

    const response = await downloadBundle("bundle-id", {
      databaseClient: createDatabaseClient("r2://updates/bundle/manifest.json"),
      storagePlugin,
    });

    expect(get).toHaveBeenCalledWith({
      storageUri: "r2://updates/bundle/manifest.json",
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="manifest.json"',
    );
    await expect(response.text()).resolves.toBe("manifest");
  });

  it("uses an owning https plugin before redirecting", async () => {
    const storageUri = "https://cdn.example.com/private/bundle.zip";
    const get = vi.fn(async () => ({ response: new Response("private") }));
    const storagePlugin = createStoragePlugin({
      name: "privateHttpsStorage",
      protocol: "https",
      get,
    });

    const response = await downloadBundle("bundle-id", {
      databaseClient: createDatabaseClient(storageUri),
      storagePlugin,
    });

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith({ storageUri });
    await expect(response.text()).resolves.toBe("private");
  });
});
