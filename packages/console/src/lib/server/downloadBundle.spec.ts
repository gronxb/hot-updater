import { createStoragePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { downloadBundle } from "./downloadBundle";

const createDatabaseClient = (storageUri: string | null) =>
  ({
    getBundleById: vi.fn(async () => ({
      id: "bundle-id",
      storageUri,
    })),
  }) as never;

describe("downloadBundle", () => {
  it("redirects already-public storage without requiring a plugin URL API", async () => {
    const response = await downloadBundle("bundle-id", {
      databaseClient: createDatabaseClient(
        "https://cdn.example.com/bundle.zip",
      ),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://cdn.example.com/bundle.zip",
    );
  });

  it("streams a custom storage Response through the Console route", async () => {
    const get = vi.fn(async () => ({
      response: new Response("bundle", {
        headers: { "content-type": "application/zip" },
      }),
    }));
    const storagePlugin = createStoragePlugin({
      name: "r2Storage",
      protocol: "r2",
      get,
    });

    const response = await downloadBundle("bundle-id", {
      databaseClient: createDatabaseClient("r2://updates/bundle.zip"),
      storagePlugin,
    });

    expect(get).toHaveBeenCalledWith({
      storageUri: "r2://updates/bundle.zip",
    });
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    await expect(response.text()).resolves.toBe("bundle");
  });
});
