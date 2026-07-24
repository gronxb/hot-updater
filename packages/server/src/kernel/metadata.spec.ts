import { describe, expect, it, vi } from "vitest";

import type { HotUpdaterVersionMetadataContribution } from "./contracts";
import {
  compileVersionMetadata,
  resolveVersionMetadata,
  VERSION_METADATA_CONTRIBUTION_BYTES,
} from "./metadata";

const contribution = (
  namespace: string,
  keys: readonly string[],
  value: Readonly<Record<string, unknown>>,
  optionalKeys?: readonly string[],
): HotUpdaterVersionMetadataContribution => {
  const result: HotUpdaterVersionMetadataContribution = {
    keys,
    namespace,
    optionalKeys,
    async resolve() {
      return {};
    },
    target: "capabilities",
  };
  Reflect.set(result, "resolve", async () => value);
  return result;
};

describe("compileVersionMetadata", () => {
  it.each([
    [
      [
        contribution("same", ["a"], { a: true }),
        contribution("same", ["b"], { b: true }),
      ],
      [],
      "DUPLICATE_METADATA_NAMESPACE",
    ],
    [
      [
        contribution("first", ["same"], { same: true }),
        contribution("second", ["same"], { same: true }),
      ],
      [],
      "DUPLICATE_METADATA_WIRE_KEY",
    ],
    [
      [
        contribution("first", ["first"], { first: true }, ["same"]),
        contribution("second", ["same"], { same: true }),
      ],
      [],
      "DUPLICATE_METADATA_WIRE_KEY",
    ],
    [
      [contribution("feature", ["core"], { core: true })],
      ["core"],
      "DUPLICATE_METADATA_WIRE_KEY",
    ],
  ])("rejects metadata ownership conflict %#", (items, reserved, code) => {
    // Given / When / Then
    expect(() =>
      compileVersionMetadata({
        contributions: items,
        reservedCoreKeys: reserved,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });
});

describe("resolveVersionMetadata", () => {
  it("allows declared optional keys while preserving required keys", async () => {
    // Given
    const withoutOptional = compileVersionMetadata({
      contributions: [
        contribution("without", ["required"], { required: true }, ["optional"]),
      ],
    });
    const withOptional = compileVersionMetadata({
      contributions: [
        contribution(
          "with",
          ["required"],
          { optional: "present", required: true },
          ["optional"],
        ),
      ],
    });

    // When
    const results = await Promise.all([
      resolveVersionMetadata({ compiled: withoutOptional }),
      resolveVersionMetadata({ compiled: withOptional }),
    ]);

    // Then
    expect(results).toEqual([
      { kind: "metadata", value: { required: true } },
      {
        kind: "metadata",
        value: { optional: "present", required: true },
      },
    ]);
  });

  it("rejects a missing required key or an undeclared optional key", async () => {
    // Given
    const invalidValues = [{ optional: true }, { extra: true, required: true }];

    // When
    const results = await Promise.all(
      invalidValues.map((value, index) =>
        resolveVersionMetadata({
          compiled: compileVersionMetadata({
            contributions: [
              contribution(`invalid-optional-${index}`, ["required"], value, [
                "optional",
              ]),
            ],
          }),
        }),
      ),
    );

    // Then
    expect(results.every((result) => result.kind === "response")).toBe(true);
  });

  it("starts every resolver concurrently with one signal", async () => {
    // Given
    const started: string[] = [];
    const signals = new Set<AbortSignal>();
    const resolvers: Array<() => void> = [];
    const items = ["second", "first"].map(
      (namespace): HotUpdaterVersionMetadataContribution => ({
        keys: [namespace],
        namespace,
        target: "capabilities",
        async resolve(signal) {
          started.push(namespace);
          signals.add(signal);
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
          return { [namespace]: true };
        },
      }),
    );
    const compiled = compileVersionMetadata({ contributions: items });

    // When
    const pending = resolveVersionMetadata({ compiled });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    for (const resolve of resolvers) resolve();
    const result = await pending;

    // Then
    expect(started).toEqual(["first", "second"]);
    expect(signals.size).toBe(1);
    expect(result).toEqual({
      kind: "metadata",
      value: { first: true, second: true },
    });
  });

  it("aborts the shared signal at the aggregate deadline", async () => {
    // Given
    vi.useFakeTimers();
    const observed: AbortSignal[] = [];
    const compiled = compileVersionMetadata({
      contributions: [
        {
          keys: ["waiting"],
          namespace: "waiting",
          target: "capabilities",
          async resolve(signal) {
            observed.push(signal);
            await new Promise(() => undefined);
            return { waiting: true };
          },
        },
      ],
    });

    // When
    const pending = resolveVersionMetadata({
      compiled,
      deadlineMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    vi.useRealTimers();

    // Then
    expect(result.kind).toBe("response");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.aborted).toBe(true);
  });

  it("rejects invalid JSON atomically without partial metadata", async () => {
    // Given
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const compiled = compileVersionMetadata({
      contributions: [
        contribution("good", ["good"], { good: "must-not-leak" }),
        contribution("invalid", ["invalid"], { invalid: cyclic }),
      ],
    });

    // When
    const result = await resolveVersionMetadata({ compiled });

    // Then
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.status).toBe(500);
      expect(await result.response.text()).not.toContain("must-not-leak");
    }
  });

  it("accepts the per-contribution UTF-8 boundary and rejects one byte over", async () => {
    // Given
    const framingBytes = new TextEncoder().encode('{"payload":""}').byteLength;
    const exact = "x".repeat(
      VERSION_METADATA_CONTRIBUTION_BYTES - framingBytes,
    );
    const exactCompiled = compileVersionMetadata({
      contributions: [contribution("exact", ["payload"], { payload: exact })],
    });
    const oversizedCompiled = compileVersionMetadata({
      contributions: [
        contribution("oversized", ["payload"], {
          payload: `${exact}x`,
        }),
      ],
    });

    // When
    const exactResult = await resolveVersionMetadata({
      compiled: exactCompiled,
    });
    const oversizedResult = await resolveVersionMetadata({
      compiled: oversizedCompiled,
    });

    // Then
    expect(exactResult.kind).toBe("metadata");
    expect(oversizedResult.kind).toBe("response");
  });

  it("rejects missing, extra, accessor, and non-finite values", async () => {
    // Given
    const accessor = Object.defineProperty({}, "declared", {
      enumerable: true,
      get() {
        throw new Error("secret");
      },
    });
    const invalidValues = [
      {},
      { declared: true, extra: true },
      accessor,
      { declared: Number.POSITIVE_INFINITY },
    ];

    // When
    const results = await Promise.all(
      invalidValues.map((value, index) =>
        resolveVersionMetadata({
          compiled: compileVersionMetadata({
            contributions: [
              contribution(`invalid-${index}`, ["declared"], value),
            ],
          }),
        }),
      ),
    );

    // Then
    expect(results.every((result) => result.kind === "response")).toBe(true);
  });

  it("rejects non-JSON own properties on arrays", async () => {
    // Given
    const nested: unknown[] = [true];
    Object.defineProperty(nested, "4294967295", {
      enumerable: true,
      value: "extra",
    });
    const compiled = compileVersionMetadata({
      contributions: [contribution("array", ["array"], { array: nested })],
    });

    // When
    const result = await resolveVersionMetadata({ compiled });

    // Then
    expect(result.kind).toBe("response");
  });
});
