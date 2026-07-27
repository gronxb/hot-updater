import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { describe, expect, it } from "vitest";

import {
  createLifecycleObservableHarness,
  type LifecycleHarness,
} from "./lifecycleObservableAdapter";
import { storageTestContext } from "./memoryStorage";

const putBytes = async (harness: LifecycleHarness): Promise<string> => {
  const body = new Uint8Array([1, 2, 3]);
  const result = await harness.plugin.put({
    context: storageTestContext,
    key: "lifecycle-object",
    body,
    contentLength: body.byteLength,
  });
  return result.storageUri;
};

describe("Storage v2 client and resource lifecycle guarantees", () => {
  it("keeps the provider client lazy until first I/O", async () => {
    // Given
    const harness = createLifecycleObservableHarness();
    const before = harness.snapshot();

    // When
    await harness.plugin.head({
      context: storageTestContext,
      storageUri: "lifecycle://storage/missing",
    });

    // Then
    expect(before.clientCreations).toBe(0);
    expect(harness.snapshot().clientCreations).toBe(1);
  });

  it("unmounts before first use without constructing a client", async () => {
    // Given
    const harness = createLifecycleObservableHarness();

    // When
    await harness.plugin.onUnmount?.();

    // Then
    expect(harness.snapshot()).toMatchObject({
      clientCreations: 0,
      clientDisposals: 0,
      unmountCount: 1,
    });
  });

  it("cleans up the client after a successful operation", async () => {
    // Given
    const harness = createLifecycleObservableHarness();
    await putBytes(harness);

    // When
    await harness.plugin.onUnmount?.();

    // Then
    expect(harness.snapshot()).toMatchObject({
      clientCreations: 1,
      clientDisposals: 1,
      unmountCount: 1,
    });
  });

  it("cleans up the client after a provider failure", async () => {
    // Given
    const harness = createLifecycleObservableHarness({ failPut: true });

    // When
    const operation = putBytes(harness);

    // Then
    await expect(operation).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "provider",
    } satisfies Partial<StoragePluginError>);
    await harness.plugin.onUnmount?.();
    expect(harness.snapshot().clientDisposals).toBe(1);
  });

  it("cleans up after aborting an in-flight input stream", async () => {
    // Given
    let notifyPull: (() => void) | undefined;
    const pulled = new Promise<void>((resolve) => {
      notifyPull = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull() {
        notifyPull?.();
      },
    });
    const controller = new AbortController();
    const harness = createLifecycleObservableHarness();
    const operation = harness.plugin.put({
      context: storageTestContext,
      key: "abort",
      body,
      contentLength: 2,
      signal: controller.signal,
    });
    await pulled;

    // When
    controller.abort();

    // Then
    await expect(operation).rejects.toMatchObject({
      name: "StoragePluginError",
      code: "aborted",
    } satisfies Partial<StoragePluginError>);
    await harness.plugin.onUnmount?.();
    expect(harness.snapshot()).toMatchObject({
      clientDisposals: 1,
      inputStreamCancellations: 1,
    });
  });

  it("cleans up after a consumer cancels the output stream", async () => {
    // Given
    const harness = createLifecycleObservableHarness();
    const storageUri = await putBytes(harness);
    const result = await harness.plugin.get({
      context: storageTestContext,
      storageUri,
    });
    if (result.kind !== "found") {
      throw new Error("Lifecycle fixture was not found.");
    }
    const reader = result.body.getReader();

    // When
    await reader.cancel();

    // Then
    await harness.plugin.onUnmount?.();
    expect(harness.snapshot()).toMatchObject({
      clientDisposals: 1,
      outputStreamCancellations: 1,
    });
  });

  it("disposes exactly once when unmounted twice", async () => {
    // Given
    const harness = createLifecycleObservableHarness();
    await putBytes(harness);

    // When
    const first = harness.plugin.onUnmount?.();
    const second = harness.plugin.onUnmount?.();

    // Then
    expect(first).toBe(second);
    await first;
    expect(harness.snapshot()).toMatchObject({
      clientDisposals: 1,
      unmountCount: 1,
    });
  });
});
