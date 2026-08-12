import type { Bundle } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "./inMemoryDatabasePlugin";

it("dual-writes the canonical channel id and name to bundles", async () => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);
  const bundle: Bundle = {
    id: "104",
    platform: "ios",
    shouldForceUpdate: false,
    enabled: true,
    fileHash: "hash-104",
    gitCommitHash: null,
    message: "104",
    channel: "beta",
    storageUri: "storage://104",
    targetAppVersion: "1.0.0",
    fingerprintHash: null,
  };

  await client.insertBundle(bundle);

  const { channels } = await plugin.models.channels.list({});
  await expect(
    plugin.models.bundles.findById(bundle.id),
  ).resolves.toMatchObject({
    channel: "beta",
    channel_id: channels[0]?.id,
  });
  expect(channels).toEqual([
    expect.objectContaining({ id: expect.any(String), name: "beta" }),
  ]);
  await expect(client.getChannels()).resolves.toEqual(channels);
  await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
    channel: "beta",
  });
});

it("moves a bundle to a canonical channel and keeps the old channel", async () => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);
  const bundle: Bundle = {
    id: "105",
    platform: "ios",
    shouldForceUpdate: false,
    enabled: true,
    fileHash: "hash-105",
    gitCommitHash: null,
    message: "105",
    channel: "beta",
    storageUri: "storage://105",
    targetAppVersion: "1.0.0",
    fingerprintHash: null,
  };
  await client.insertBundle(bundle);

  await client.updateBundleById(bundle.id, { channel: "stable" });

  const { channels } = await plugin.models.channels.list({});
  const stable = channels.find(({ name }) => name === "stable");
  await expect(
    plugin.models.bundles.findById(bundle.id),
  ).resolves.toMatchObject({
    channel: "stable",
    channel_id: stable?.id,
  });
  expect((await client.getChannels()).map(({ name }) => name)).toEqual([
    "beta",
    "stable",
  ]);
});

it("returns distinct sorted channel names", async () => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);
  for (const [id, channel] of [
    ["106", "staging"],
    ["107", "production"],
    ["108", "staging"],
  ] as const) {
    await client.insertBundle({
      id,
      platform: "ios",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: `hash-${id}`,
      gitCommitHash: null,
      message: id,
      channel,
      storageUri: `storage://${id}`,
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
    });
  }

  expect((await client.getChannels()).map(({ name }) => name)).toEqual([
    "production",
    "staging",
  ]);
});

it("lists channels without reading any bundle rows", async () => {
  const plugin = createInMemoryDatabasePlugin();
  const client = createDatabaseClient(plugin);
  await client.insertBundle({
    id: "109",
    platform: "ios",
    shouldForceUpdate: false,
    enabled: true,
    fileHash: "hash-109",
    gitCommitHash: null,
    message: "109",
    channel: "production",
    storageUri: "storage://109",
    targetAppVersion: "1.0.0",
    fingerprintHash: null,
  });
  const findMany = vi.spyOn(plugin.models.bundles, "findMany");
  const list = vi.spyOn(plugin.models.channels, "list");

  await expect(client.getChannels()).resolves.toEqual([
    expect.objectContaining({ name: "production" }),
  ]);

  expect(list).toHaveBeenCalledWith({});
  expect(findMany).not.toHaveBeenCalled();
});
