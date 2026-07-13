import type { Bundle } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { expect, it } from "vitest";

import { createInMemoryDatabaseAdapter } from "./inMemoryDatabaseAdapter";

it("stores normalized channel ids while exposing channel names", async () => {
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
  const channel = await adapter.findOne({
    model: "channels",
    where: [{ field: "name", value: "beta" }],
  });
  expect(channel?.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await expect(
    adapter.findOne({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
      select: ["channel_id"],
    }),
  ).resolves.toEqual({ channel_id: channel?.id });
  await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
    channel: "beta",
  });
});
