import { S3Client } from "@aws-sdk/client-s3";
import { env } from "@hot-updater/core/config";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { expect, it, onTestFinished, vi } from "vitest";

import { s3Storage } from "./storage/node";
import type { S3TestServer } from "./storage/s3TestServer";
import { retainClientThroughStream } from "./storage/stream";

const credentials = {
  accessKeyId: "literal-access-key",
  secretAccessKey: "literal-secret-key",
} as const;
const context = createNodeStorageContext({ environment: {} });

const trackUnhandledRejections = (): unknown[] => {
  const reasons: unknown[] = [];
  const listener = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", listener);
  onTestFinished(() => {
    process.off("unhandledRejection", listener);
  });
  return reasons;
};

const waitForUnhandledRejections = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

export const setupS3AbortLifecycleTests = (
  getServer: () => S3TestServer,
): void => {
  it("aborts a returned tagged stream before its first read exactly once", async () => {
    const unhandledRejections = trackUnhandledRejections();
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const plugin = s3Storage({
      bucketName: env("BUCKET"),
      endpoint: env("ENDPOINT"),
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
    });
    const taggedContext = createNodeStorageContext({
      environment: {
        BUCKET: "storage-v2",
        ENDPOINT: getServer().endpoint,
      },
    });
    const key = "abort-stream/before-read";
    await plugin.put({
      context: taggedContext,
      key,
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
    });
    destroy.mockClear();
    const controller = new AbortController();
    const result = await plugin.get({
      context: taggedContext,
      storageUri: `s3://storage-v2/${key}`,
      signal: controller.signal,
    });
    if (result.kind !== "found") {
      throw new TypeError("Expected the abort stream fixture to exist.");
    }
    const reader = result.body.getReader();

    expect(destroy).not.toHaveBeenCalled();
    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "aborted",
    });
    await expect(reader.cancel()).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "aborted",
    });
    await vi.waitFor(() => {
      expect(getServer().cancelledStreams).toContain(key);
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    await waitForUnhandledRejections();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toEqual([]);
    destroy.mockRestore();
  });

  it("aborts a returned literal stream during a read without destroying its cache", async () => {
    const unhandledRejections = trackUnhandledRejections();
    const destroy = vi.spyOn(S3Client.prototype, "destroy");
    const plugin = s3Storage({
      bucketName: "storage-v2",
      endpoint: getServer().endpoint,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
    });
    const key = "abort-stream/during-read";
    await plugin.put({
      context,
      key,
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
    });
    const controller = new AbortController();
    const result = await plugin.get({
      context,
      storageUri: `s3://storage-v2/${key}`,
      signal: controller.signal,
    });
    if (result.kind !== "found") {
      throw new TypeError("Expected the abort stream fixture to exist.");
    }
    const reader = result.body.getReader();
    const first = await reader.read();
    expect(first).toMatchObject({ done: false });
    expect(first.value).toEqual(new Uint8Array([1]));
    const pendingRead = reader.read();

    controller.abort();

    await expect(pendingRead).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "aborted",
    });
    await expect(reader.cancel()).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "aborted",
    });
    await vi.waitFor(() => {
      expect(getServer().cancelledStreams).toContain(key);
    });
    expect(destroy).not.toHaveBeenCalled();
    await plugin.onUnmount?.();
    expect(destroy).toHaveBeenCalledTimes(1);
    await waitForUnhandledRejections();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toEqual([]);
    destroy.mockRestore();
  });

  it("keeps abort primary when underlying stream cancellation fails", async () => {
    const unhandledRejections = trackUnhandledRejections();
    const release = vi.fn();
    const cancel = vi.fn(() => {
      throw new Error("late cancellation failure");
    });
    const source = new ReadableStream<Uint8Array>({
      cancel,
    });
    const controller = new AbortController();
    const reader = retainClientThroughStream(
      source,
      release,
      controller.signal,
    ).getReader();

    controller.abort();

    await expect(reader.read()).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "aborted",
    });
    await waitForUnhandledRejections();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(unhandledRejections).toEqual([]);
  });
};
