import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterVersionMetadataContribution,
  JsonValue,
} from "./contracts";
import {
  compileVersionMetadata,
  resolveVersionMetadata,
  VERSION_METADATA_AGGREGATE_BYTES,
  VERSION_METADATA_CONTRIBUTION_BYTES,
  VERSION_METADATA_DEADLINE_MS,
} from "./metadata";

const SECRET = "must-not-appear-4f079c";
const encoder = new TextEncoder();

const metadataContribution = (
  namespace: string,
  key: string,
  resolve: (signal: AbortSignal) => Promise<unknown>,
): HotUpdaterVersionMetadataContribution => {
  const value: HotUpdaterVersionMetadataContribution = {
    keys: [key],
    namespace,
    async resolve() {
      return { [key]: true };
    },
    target: "capabilities",
  };
  Reflect.set(value, "resolve", resolve);
  return value;
};

const metadataValueAtBytes = (
  key: string,
  bytes: number,
): Readonly<Record<string, JsonValue>> => {
  const framingBytes = encoder.encode(JSON.stringify({ [key]: "" })).byteLength;
  return { [key]: "x".repeat(bytes - framingBytes) };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("security conformance: metadata and secrecy", () => {
  it("aborts all work at the fixed five-second deadline", async () => {
    // Given
    vi.useFakeTimers();
    const aborted = vi.fn();
    const compiled = compileVersionMetadata({
      contributions: [
        metadataContribution("waiting", "waiting", async (signal) => {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted();
                reject(new Error(SECRET));
              },
              { once: true },
            );
          });
          return { waiting: true };
        }),
      ],
    });
    let settled = false;

    // When
    const pending = resolveVersionMetadata({ compiled }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(VERSION_METADATA_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    // Then
    expect(result.kind).toBe("response");
    expect(aborted).toHaveBeenCalledOnce();
    if (result.kind === "response") {
      expect(result.response.status).toBe(500);
      expect(await result.response.text()).not.toContain(SECRET);
    }
  });

  it("enforces exact contribution keys and the 16 KiB UTF-8 boundary atomically", async () => {
    // Given
    const exact = metadataValueAtBytes(
      "payload",
      VERSION_METADATA_CONTRIBUTION_BYTES,
    );
    const oversized = {
      payload: `${String(exact.payload)}x`,
    };
    const invalid = Object.defineProperty({}, "payload", {
      enumerable: true,
      get() {
        throw new Error(SECRET);
      },
    });

    // When
    const results = await Promise.all(
      [exact, oversized, {}, { payload: true, extra: SECRET }, invalid].map(
        (value, index) =>
          resolveVersionMetadata({
            compiled: compileVersionMetadata({
              contributions: [
                metadataContribution(
                  `item-${index}`,
                  "payload",
                  async () => value,
                ),
              ],
            }),
          }),
      ),
    );

    // Then
    expect(results[0]?.kind).toBe("metadata");
    for (const result of results.slice(1)) {
      expect(result.kind).toBe("response");
      if (result.kind === "response") {
        expect(await result.response.text()).not.toContain(SECRET);
      }
    }
  });

  it("accepts exactly 64 KiB of merged JSON and rejects one byte over", async () => {
    // Given
    const keys = ["a", "b", "c", "d", "e"] as const;
    const values = Object.fromEntries(
      keys.map((key, index) => [
        key,
        index === keys.length - 1
          ? ""
          : metadataValueAtBytes(key, VERSION_METADATA_CONTRIBUTION_BYTES)[key],
      ]),
    );
    const initialBytes = encoder.encode(JSON.stringify(values)).byteLength;
    const reduction = initialBytes - VERSION_METADATA_AGGREGATE_BYTES;
    values.a = String(values.a).slice(0, -reduction);
    const exactBytes = encoder.encode(JSON.stringify(values)).byteLength;
    const exactCompiled = compileVersionMetadata({
      contributions: keys.map((key) =>
        metadataContribution(key, key, async () => ({ [key]: values[key] })),
      ),
    });
    const oversizedCompiled = compileVersionMetadata({
      contributions: keys.map((key) =>
        metadataContribution(key, key, async () => ({
          [key]: key === "a" ? `${values[key]}x` : values[key],
        })),
      ),
    });

    // When
    const exact = await resolveVersionMetadata({ compiled: exactCompiled });
    const oversized = await resolveVersionMetadata({
      compiled: oversizedCompiled,
    });

    // Then
    expect(exactBytes).toBe(VERSION_METADATA_AGGREGATE_BYTES);
    expect(exact.kind).toBe("metadata");
    expect(oversized.kind).toBe("response");
  });

  it("never logs or partially returns provider-controlled metadata", async () => {
    // Given
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const compiled = compileVersionMetadata({
      contributions: [
        metadataContribution("good", "good", async () => ({ good: SECRET })),
        metadataContribution("failed", "failed", async () =>
          Promise.reject(new Error(SECRET)),
        ),
      ],
    });

    // When
    const result = await resolveVersionMetadata({ compiled });

    // Then
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(await result.response.text()).not.toContain(SECRET);
    }
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
