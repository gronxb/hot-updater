import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createBlobDatabaseAdapter } from "./createBlobDatabaseAdapter";
import { createDatabaseClient } from "./databaseClient";

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: id,
  channel: "production",
  storageUri: `storage://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

describe("database client pagination", () => {
  it("hydrates only the selected bundle row", async () => {
    // Given
    const store = new Map<string, unknown>();
    const adapter = createBlobDatabaseAdapter({
      name: "pagination-memory",
      factory: () => ({
        apiBasePath: "/api/check-update",
        listObjects: async (prefix) =>
          [...store.keys()].filter((key) => key.startsWith(prefix)),
        loadObject: async (key) => store.get(key) ?? null,
        uploadObject: async (key, value) => void store.set(key, value),
        invalidatePaths: async () => undefined,
      }),
    })({});
    const client = createDatabaseClient(adapter);
    for (const id of ["001", "002", "003"]) {
      await client.insertBundle(createBundle(id));
    }
    const findMany = vi.spyOn(adapter, "findMany");

    // When
    const page = await client.getBundles({
      limit: 1,
      orderBy: { field: "id", direction: "desc" },
    });

    // Then
    const patchQueries = findMany.mock.calls.flatMap(([input]) =>
      input.model === "bundle_patches" ? [input] : [],
    );
    const channelQueries = findMany.mock.calls.flatMap(([input]) =>
      input.model === "channels" ? [input] : [],
    );
    expect(page.data.map(({ id }) => id)).toEqual(["003"]);
    expect(patchQueries).toHaveLength(1);
    expect(patchQueries[0]?.where).toEqual([
      { field: "bundle_id", operator: "in", value: ["003"] },
    ]);
    expect(channelQueries).toHaveLength(1);
    expect(channelQueries[0]?.where).toEqual([
      expect.objectContaining({ field: "id", value: expect.any(Array) }),
    ]);
  });
});
