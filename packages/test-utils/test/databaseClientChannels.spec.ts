import { createDatabaseClient } from "@hot-updater/plugin-core";
import { expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "./inMemoryDatabasePlugin";

const artifact = (id: string) => ({
  id,
  platform: "ios" as const,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  storageUri: `storage://${id}`,
});

it("manages canonical Channels independently from Bundle artifacts", async () => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);

  await expect(
    client.insertChannel({
      row: { id: "channel-beta", name: "beta" },
      onConflict: "returnExisting",
    }),
  ).resolves.toEqual({
    row: { id: "channel-beta", name: "beta" },
    inserted: true,
  });
  await client.insertBundle(artifact("104"));

  const stored = await plugin.models.bundles.findById("104");
  expect(stored).toMatchObject({ id: "104", platform: "ios" });
  expect(stored).not.toHaveProperty("channel");
  expect(stored).not.toHaveProperty("channel_id");
  await expect(client.getChannels()).resolves.toEqual([
    { id: "channel-beta", name: "beta" },
  ]);
});

it("returns the existing canonical Channel for a duplicate name", async () => {
  const client = createDatabaseClient(createInMemoryDatabasePlugin());
  await client.insertChannel({
    row: { id: "channel-beta", name: "beta" },
    onConflict: "returnExisting",
  });

  await expect(
    client.insertChannel({
      row: { id: "losing-id", name: "beta" },
      onConflict: "returnExisting",
    }),
  ).resolves.toEqual({
    row: { id: "channel-beta", name: "beta" },
    inserted: false,
  });
});

it("returns explicitly created Channels in sorted order", async () => {
  const client = createDatabaseClient(createInMemoryDatabasePlugin());
  for (const [id, name] of [
    ["channel-staging", "staging"],
    ["channel-production", "production"],
  ] as const) {
    await client.insertChannel({
      row: { id, name },
      onConflict: "returnExisting",
    });
  }

  expect((await client.getChannels()).map(({ name }) => name)).toEqual([
    "production",
    "staging",
  ]);
});

it("lists Channels without reading Bundle rows", async () => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);
  await client.insertChannel({
    row: { id: "channel-production", name: "production" },
    onConflict: "returnExisting",
  });
  const findMany = vi.spyOn(plugin.models.bundles, "findMany");
  const list = vi.spyOn(plugin.models.channels, "list");

  await expect(client.getChannels()).resolves.toEqual([
    { id: "channel-production", name: "production" },
  ]);

  expect(list).toHaveBeenCalledWith({});
  expect(findMany).not.toHaveBeenCalled();
});
