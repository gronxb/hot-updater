import type { Bundle } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { expect, it } from "vitest";

import { createInMemoryDatabaseAdapter } from "./inMemoryDatabaseAdapter";

it("stores channel names directly on bundles", async () => {
  // Given
  const adapter = createInMemoryDatabaseAdapter();
  const client = createDatabaseClient(adapter);
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

  // When
  await client.insertBundle(bundle);

  // Then
  await expect(
    adapter.findOne({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
      select: ["channel"],
    }),
  ).resolves.toEqual({ channel: "beta" });
  await expect(client.getChannels()).resolves.toEqual(["beta"]);
  await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
    channel: "beta",
  });
});

it("updates the bundle channel directly", async () => {
  // Given
  const adapter = createInMemoryDatabaseAdapter();
  const client = createDatabaseClient(adapter);
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

  // When
  await client.updateBundleById(bundle.id, { channel: "stable" });

  // Then
  await expect(
    adapter.findOne({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
      select: ["channel"],
    }),
  ).resolves.toEqual({ channel: "stable" });
  await expect(client.getChannels()).resolves.toEqual(["stable"]);
});

it("returns distinct sorted channel names", async () => {
  const adapter = createInMemoryDatabaseAdapter();
  const client = createDatabaseClient(adapter);
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

  await expect(client.getChannels()).resolves.toEqual([
    "production",
    "staging",
  ]);
});
