import { describe, expect, it, vi } from "vitest";

import {
  applyBoundedBody,
  checkDeclaredBodyLength,
  HotUpdaterPayloadTooLargeError,
} from "./requestBody";

const streamedRequest = (chunks: readonly Uint8Array[]) => {
  const pull = vi.fn();
  const cancel = vi.fn();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel,
    pull(controller) {
      pull();
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
  });
  const init: RequestInit & { readonly duplex: "half" } = {
    body,
    duplex: "half",
    method: "POST",
  };
  return {
    cancel,
    pull,
    request: new Request("https://example.com/body", init),
  };
};

describe("request body policy", () => {
  it("rejects an oversized declared length without pulling the body", () => {
    // Given
    const source = streamedRequest([new Uint8Array([1])]);
    source.request.headers.set("Content-Length", "11");

    // When
    const response = checkDeclaredBodyLength(source.request.headers, 10);

    // Then
    expect(response?.status).toBe(413);
    expect(source.pull).not.toHaveBeenCalled();
    expect(source.request.bodyUsed).toBe(false);
  });

  it("passes an exact actual byte limit", async () => {
    // Given
    const source = streamedRequest([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
    ]);

    // When
    const bounded = applyBoundedBody(source.request, 3);

    // Then
    await expect(bounded.arrayBuffer()).resolves.toHaveProperty(
      "byteLength",
      3,
    );
  });

  it("cancels on the first actual byte over the limit", async () => {
    // Given
    const source = streamedRequest([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5]),
    ]);

    // When
    const bounded = applyBoundedBody(source.request, 3);

    // Then
    await expect(bounded.arrayBuffer()).rejects.toBeInstanceOf(
      HotUpdaterPayloadTooLargeError,
    );
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it("keeps the bounded error opaque when source cancellation fails", async () => {
    // Given
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("source secret");
      },
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array([1, 2]));
      },
    });
    const init: RequestInit & { readonly duplex: "half" } = {
      body,
      duplex: "half",
      method: "POST",
    };
    const request = new Request("https://example.com/body", init);

    // When
    const bounded = applyBoundedBody(request, 1);

    // Then
    await expect(bounded.arrayBuffer()).rejects.toBeInstanceOf(
      HotUpdaterPayloadTooLargeError,
    );
    expect(pullCount).toBeGreaterThan(0);
  });
});
