import type { Bundle } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabaseAdapter,
  type TransactionDatabaseAdapter,
} from "@hot-updater/plugin-core";
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
      select: ["channel", "channel_id"],
    }),
  ).resolves.toEqual({ channel: "beta", channel_id: channel?.id });
  await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
    channel: "beta",
  });
});

it("updates legacy and normalized channel fields together", async () => {
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
  const channel = await adapter.findOne({
    model: "channels",
    where: [{ field: "name", value: "stable" }],
  });
  await expect(
    adapter.findOne({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
      select: ["channel", "channel_id"],
    }),
  ).resolves.toEqual({ channel: "stable", channel_id: channel?.id });
});

it("retries the whole transaction after a concurrent channel insert", async () => {
  // Given
  const base = createInMemoryDatabaseAdapter();
  const runBaseTransaction = base.transaction;
  if (!runBaseTransaction) throw new Error("transaction unavailable");
  let transactionAttempts = 0;
  let abortedTransactionLookups = 0;
  const adapter: DatabaseAdapter = {
    ...base,
    transaction: async (callback) => {
      transactionAttempts += 1;
      if (transactionAttempts > 1) return runBaseTransaction(callback);
      let aborted = false;
      const failedTransaction: TransactionDatabaseAdapter = {
        ...base,
        findOne: async (input) => {
          if (aborted) {
            abortedTransactionLookups += 1;
            throw new Error("current transaction is aborted");
          }
          if (input.model === "channels") return null;
          return base.findOne(input);
        },
        create: async (input) => {
          if (input.model === "channels") {
            await base.create(input);
            aborted = true;
            throw new Error("duplicate channel name");
          }
          return base.create(input);
        },
      };
      return callback(failedTransaction);
    },
  };
  const client = createDatabaseClient(adapter);
  const bundle: Bundle = {
    id: "106",
    platform: "ios",
    shouldForceUpdate: false,
    enabled: true,
    fileHash: "hash-106",
    gitCommitHash: null,
    message: "106",
    channel: "concurrent",
    storageUri: "storage://106",
    targetAppVersion: "1.0.0",
    fingerprintHash: null,
  };

  // When
  await client.insertBundle(bundle);

  // Then
  await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
    channel: "concurrent",
  });
  expect(transactionAttempts).toBe(2);
  expect(abortedTransactionLookups).toBe(0);
});
