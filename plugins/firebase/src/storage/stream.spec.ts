import { StoragePluginError } from "@hot-updater/plugin-core/storage";
import { describe, expect, it } from "vitest";

import { wrapFirebaseStream } from "./stream";

describe("wrapFirebaseStream", () => {
  it("preserves chunks and EOF", async () => {
    let settled = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const wrapped = wrapFirebaseStream(source, undefined, async () => {
      settled += 1;
    });
    const reader = wrapped.getReader();

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(settled).toBe(1);
  });

  it("preserves an upstream StoragePluginError instance", async () => {
    const upstreamError = new StoragePluginError(
      "provider",
      "upstream read failed",
    );
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw upstreamError;
      },
    });
    const wrapped = wrapFirebaseStream(source, undefined, async () => {});

    await expect(wrapped.getReader().read()).rejects.toBe(upstreamError);
  });

  it("releases the upstream reader lock after EOF", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const wrapped = wrapFirebaseStream(source, undefined, async () => {});
    const reader = wrapped.getReader();

    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(source.locked).toBe(false);
  });

  it("releases the upstream reader lock after a rejected read", async () => {
    const upstreamError = new StoragePluginError(
      "provider",
      "upstream read failed",
    );
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw upstreamError;
      },
    });
    const wrapped = wrapFirebaseStream(source, undefined, async () => {});

    await expect(wrapped.getReader().read()).rejects.toBe(upstreamError);
    expect(source.locked).toBe(false);
  });

  it("releases the upstream reader lock after consumer cancellation", async () => {
    const reason = new Error("consumer cancelled");
    let cancelCalls = 0;
    let cancelReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(receivedReason) {
        cancelCalls += 1;
        cancelReason = receivedReason;
      },
    });
    const wrapped = wrapFirebaseStream(source, undefined, async () => {});

    await wrapped.cancel(reason);

    expect(cancelCalls).toBe(1);
    expect(cancelReason).toBe(reason);
    expect(source.locked).toBe(false);
  });

  it("releases the upstream reader lock after repeated consumer cancellation", async () => {
    const reason = new Error("consumer cancelled twice");
    let cancelCalls = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
      },
    });
    const wrapped = wrapFirebaseStream(source, undefined, async () => {});

    await wrapped.cancel(reason);
    await wrapped.cancel(reason);

    expect(cancelCalls).toBe(1);
    expect(source.locked).toBe(false);
  });
});
