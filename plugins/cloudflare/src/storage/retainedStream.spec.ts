import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { describe, expect, it } from "vitest";

import { retainR2ClientThroughStream } from "./retainedStream";

const readAll = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return chunks;
    }
    chunks.push(next.value);
  }
};

describe("retainR2ClientThroughStream", () => {
  it("preserves bytes through normal EOF", async () => {
    // Given
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    let releases = 0;
    const retained = retainR2ClientThroughStream(source, () => {
      releases += 1;
    });

    // When
    const chunks = await readAll(retained);

    // Then
    expect(chunks).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect(releases).toBe(1);
  });

  it("propagates the original upstream read error", async () => {
    // Given
    const originalError = new Error("upstream read failed");
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(originalError);
      },
    });
    const retained = retainR2ClientThroughStream(source, () => {});
    const reader = retained.getReader();

    // When
    const result = reader.read();

    // Then
    await expect(result).rejects.toBe(originalError);
  });

  it("releases the upstream reader lock after EOF", async () => {
    // Given
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const retained = retainR2ClientThroughStream(source, () => {});

    // When
    await readAll(retained);

    // Then
    expect(source.locked).toBe(false);
  });

  it("releases the upstream reader lock after a read rejection", async () => {
    // Given
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(new Error("upstream read failed"));
      },
    });
    const retained = retainR2ClientThroughStream(source, () => {});
    const reader = retained.getReader();

    // When
    await expect(reader.read()).rejects.toThrow("upstream read failed");

    // Then
    expect(source.locked).toBe(false);
  });

  it("releases the upstream reader lock and cancels upstream once", async () => {
    // Given
    let cancels = 0;
    let cancellationReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancels += 1;
        cancellationReason = reason;
      },
    });
    const retained = retainR2ClientThroughStream(source, () => {});
    const reader = retained.getReader();

    // When
    await reader.cancel("consumer cancelled");

    // Then
    expect(source.locked).toBe(false);
    expect(cancels).toBe(1);
    expect(cancellationReason).toBe("consumer cancelled");
  });

  it("keeps the upstream reader unlocked through repeated cancellation", async () => {
    // Given
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancels += 1;
      },
    });
    const retained = retainR2ClientThroughStream(source, () => {});
    const reader = retained.getReader();

    // When
    await reader.cancel("first cancellation");
    await reader.cancel("second cancellation");

    // Then
    expect(source.locked).toBe(false);
    expect(cancels).toBe(1);
  });

  it("fails a pre-aborted response stream and releases its lease", async () => {
    // Given
    const abortController = new AbortController();
    const abortReason = new Error("pre-aborted response");
    abortController.abort(abortReason);
    let cancels = 0;
    let cancellationReason: unknown;
    let releases = 0;
    let resolveReleased: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel(reason) {
        cancels += 1;
        cancellationReason = reason;
      },
    });
    const retained = retainR2ClientThroughStream(
      source,
      () => {
        releases += 1;
        resolveReleased();
      },
      abortController.signal,
    );
    const reader = retained.getReader();

    // When
    const result = reader.read();

    // Then
    await expect(result).rejects.toBeInstanceOf(StoragePluginError);
    await expect(result).rejects.toMatchObject({
      code: "aborted",
      cause: abortReason,
    } satisfies Partial<StoragePluginError>);
    await released;
    expect(source.locked).toBe(false);
    expect(cancels).toBe(1);
    expect(releases).toBe(1);
    expect(cancellationReason).toMatchObject({
      code: "aborted",
      cause: abortReason,
    } satisfies Partial<StoragePluginError>);
  });

  it("settles an abort raised while its listener is registering", async () => {
    // Given
    const abortController = new AbortController();
    const abortReason = new Error("listener registration race");
    const signal = abortController.signal;
    const originalAddEventListener = signal.addEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => {
      originalAddEventListener(type, listener, options);
      if (type === "abort") {
        abortController.abort(abortReason);
      }
    };
    let cancels = 0;
    let releases = 0;
    let resolveReleased: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancels += 1;
      },
    });
    const retained = retainR2ClientThroughStream(
      source,
      () => {
        releases += 1;
        resolveReleased();
      },
      signal,
    );
    const reader = retained.getReader();

    // When
    const result = reader.read();

    // Then
    await expect(result).rejects.toMatchObject({
      code: "aborted",
      cause: abortReason,
    } satisfies Partial<StoragePluginError>);
    await released;
    expect(source.locked).toBe(false);
    expect(cancels).toBe(1);
    expect(releases).toBe(1);
  });
});
