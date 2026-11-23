import { afterEach, describe, expect, it, vi } from "vitest";

import { spreadDownloadBody } from "./spread-download.ts";

afterEach(() => {
  vi.useRealTimers();
});

async function readAll(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

describe("spreadDownloadBody", () => {
  it("sends every byte, the last part only after the duration", async () => {
    vi.useFakeTimers();
    const body = new Uint8Array(1_000).map((_, index) => index % 251);
    const chunks: Uint8Array[] = [];
    let done = false;
    const reading = readAll(spreadDownloadBody(body, 19_000)).then((result) => {
      chunks.push(...result);
      done = true;
    });

    await vi.advanceTimersByTimeAsync(18_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await reading;

    expect(chunks).toHaveLength(20);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(body));
  });

  it("sends a body smaller than the parts one byte at a time", async () => {
    vi.useFakeTimers();
    const reading = readAll(spreadDownloadBody(new Uint8Array([1, 2, 3]), 10));
    await vi.advanceTimersByTimeAsync(10);
    expect((await reading).map((chunk) => [...chunk])).toEqual([[1], [2], [3]]);
  });

  it("ends an empty body at once", async () => {
    expect(await readAll(spreadDownloadBody(new Uint8Array(), 1_000))).toEqual(
      [],
    );
  });
});
