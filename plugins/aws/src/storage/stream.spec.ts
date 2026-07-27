import { describe, expect, it, vi } from "vitest";

import { retainClientThroughStream } from "./stream";

describe("AWS Storage stream reader lifecycle", () => {
  it("forwards normal bytes through EOF", async () => {
    // Given
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const stream = retainClientThroughStream(source, vi.fn());

    // When
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

    // Then
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("forwards the original upstream read error", async () => {
    // Given
    const upstreamError = new Error("upstream read failed");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(upstreamError);
      },
    });
    const reader = retainClientThroughStream(source, vi.fn()).getReader();

    // When
    const error = await reader.read().catch((reason: unknown) => reason);

    // Then
    expect(error).toBe(upstreamError);
  });

  it("releases the upstream reader after EOF", async () => {
    // Given
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const reader = retainClientThroughStream(source, vi.fn()).getReader();

    // When
    const first = await reader.read();
    const terminal = await reader.read();

    // Then
    expect(first.value).toEqual(new Uint8Array([1, 2, 3]));
    expect(terminal.done).toBe(true);
    expect(source.locked).toBe(false);
  });

  it("releases the upstream reader after a read rejection", async () => {
    // Given
    const upstreamError = new Error("upstream read failed");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(upstreamError);
      },
    });
    const reader = retainClientThroughStream(source, vi.fn()).getReader();

    // When
    const error = await reader.read().catch((reason: unknown) => reason);

    // Then
    expect(error).toBe(upstreamError);
    expect(source.locked).toBe(false);
  });

  it("releases the upstream reader after first and repeated cancellation", async () => {
    // Given
    let upstreamCancelCount = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelCount += 1;
      },
    });
    const reader = retainClientThroughStream(source, vi.fn()).getReader();

    // When
    await reader.cancel("consumer stopped");

    // Then
    expect(source.locked).toBe(false);
    expect(upstreamCancelCount).toBe(1);

    // When
    await reader.cancel("consumer stopped again");

    // Then
    expect(source.locked).toBe(false);
    expect(upstreamCancelCount).toBe(1);
  });
});
