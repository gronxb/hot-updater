import { describe, expect, it } from "vitest";

import type { BundleChangeV2 } from "./bundles";
import { DatabaseConnectorErrorV2 } from "./errors";
import {
  canonicalizeDatabaseValueV1,
  hashDatabaseChangeSetPayloadV1,
  hashDatabaseScopeV1,
} from "./index";

const orderedChanges = [
  {
    type: "delete",
    id: "a",
    precondition: { state: "revision", revision: "r1" },
  },
  {
    type: "delete",
    id: "b",
    precondition: { state: "revision", revision: "r2" },
  },
] satisfies readonly BundleChangeV2[];

const expectCanonicalizationFailure = (value: unknown): void => {
  expect(() => canonicalizeDatabaseValueV1(value)).toThrowError(
    expect.objectContaining({
      name: "DatabaseConnectorErrorV2",
      code: "CANONICALIZATION_FAILED",
    }),
  );
};

describe("canonicalizeDatabaseValueV1", () => {
  it("emits stable JSON for nested keys, Unicode, numbers, and absent fields", () => {
    // Given equivalent objects with different insertion orders
    const first = {
      z: [3, { β: "café", a: true }],
      a: { present: 0 },
    };
    const second = {
      a: { present: 0 },
      z: [3, { a: true, β: "café" }],
    };

    // When each object is canonicalized
    const firstCanonical = canonicalizeDatabaseValueV1(first);
    const secondCanonical = canonicalizeDatabaseValueV1(second);

    // Then the checked-in literal vector is identical
    expect(firstCanonical).toBe(
      '{"a":{"present":0},"z":[3,{"a":true,"β":"café"}]}',
    );
    expect(secondCanonical).toBe(firstCanonical);
    expect(
      canonicalizeDatabaseValueV1([
        0,
        1e-7,
        1e21,
        0.000001,
        Number.MAX_SAFE_INTEGER,
        "é",
        "e\u0301",
      ]),
    ).toBe('[0,1e-7,1e+21,0.000001,9007199254740991,"é","é"]');
  });

  it("rejects unsupported primitive and number classes with typed errors", () => {
    // Given every unsupported primitive or number class
    const rejectedValues: readonly unknown[] = [
      undefined,
      1n,
      Symbol("value"),
      () => true,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "\ud800",
      "\udfff",
    ];

    // When and Then each value is canonicalized
    for (const value of rejectedValues) {
      expectCanonicalizationFailure(value);
    }
  });

  it("rejects sparse, decorated, accessor, and non-enumerable arrays", () => {
    // Given malformed arrays from each rejected descriptor class
    const sparse: unknown[] = [];
    sparse.length = 1;
    const decorated: unknown[] = [1];
    Object.defineProperty(decorated, "extra", {
      enumerable: true,
      value: 2,
    });
    const accessor: unknown[] = [1];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => 1,
    });
    const nonEnumerable: unknown[] = [1];
    Object.defineProperty(nonEnumerable, "0", {
      enumerable: false,
      value: 1,
    });

    // When and Then each array is canonicalized
    for (const value of [sparse, decorated, accessor, nonEnumerable]) {
      expectCanonicalizationFailure(value);
    }
  });

  it("rejects symbol, accessor, hidden, inherited, cyclic, and bad-key objects", () => {
    // Given malformed objects from each rejected structural class
    class InheritedValue {
      readonly own = true;
    }
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    const hidden = Object.defineProperty({}, "value", {
      enumerable: false,
      value: 1,
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const badKey = { "\ud800": true };

    // When and Then each object is canonicalized
    for (const value of [
      { [Symbol("hidden")]: true },
      accessor,
      hidden,
      new InheritedValue(),
      new Date(0),
      cyclic,
      badKey,
      { optional: undefined },
    ]) {
      expectCanonicalizationFailure(value);
    }
  });

  it("validates descriptors before reading any property value", () => {
    // Given an invalid symbol key beside an enumerable getter
    let getterCalls = 0;
    const value = Object.defineProperty(
      { [Symbol("invalid")]: true },
      "unread",
      {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "should-not-run";
        },
      },
    );

    // When canonicalization rejects the descriptor set
    expectCanonicalizationFailure(value);

    // Then it never invokes the getter
    expect(getterCalls).toBe(0);
  });

  it("serializes dense proxied arrays without reading live length", () => {
    // Given a dense array whose live property reads are hostile
    let getCalls = 0;
    const value = new Proxy(["first", "second"], {
      get: () => {
        getCalls += 1;
        throw new RangeError("array live read");
      },
    });

    // When the array is canonicalized from its own descriptors
    const canonical = canonicalizeDatabaseValueV1(value);

    // Then no get trap runs and the descriptor snapshot determines the bytes
    expect(canonical).toBe('["first","second"]');
    expect(getCalls).toBe(0);
  });

  it("converts hostile array descriptor inspection into a typed error", () => {
    // Given an array Proxy that refuses descriptor inspection
    const value = new Proxy(["first"], {
      getOwnPropertyDescriptor: () => {
        throw new RangeError("descriptor inspection failed");
      },
    });

    // When and Then the array crosses the canonical identity boundary
    expectCanonicalizationFailure(value);
  });
});

describe("database-v2 versioned hashes", () => {
  it("matches literal change-set vectors and preserves operation order", async () => {
    // Given ordered normalized changes and their reverse
    const reversedChanges = [...orderedChanges].reverse();

    // When each payload is hashed
    const orderedHash = await hashDatabaseChangeSetPayloadV1(orderedChanges);
    const reversedHash = await hashDatabaseChangeSetPayloadV1(reversedChanges);

    // Then both match independent literal SHA-256 vectors and differ
    expect(orderedHash).toBe(
      "sha256:e11b5a6fd7acb815c7293dadd9ab78a6b977ac69c11e1f76453880c27a0bf916",
    );
    expect(reversedHash).toBe(
      "sha256:33cfc4daf97a75b10ab4db50e08eb50355041be4b18d32a7931d844b7ceaae1c",
    );
    expect(reversedHash).not.toBe(orderedHash);
  });

  it("hashes exactly tenant and principal in a separate domain", async () => {
    // Given the same asserted IDs with unrelated contexts
    const scope = { principalId: "principal-a", tenantId: "tenant-a" };

    // When the scope identity is hashed
    const hash = await hashDatabaseScopeV1(scope);

    // Then it matches the checked-in scope-domain vector
    expect(hash).toBe(
      "sha256:0446f3b9ed66598af4648c82ec418e91e26c4a7d2af8cc19b7894c6e753c22ff",
    );
  });

  it("fails closed when an injected digest is not exactly 32 bytes", async () => {
    // Given digest providers that return the wrong size or throw
    const shortDigest = async (): Promise<Uint8Array> => new Uint8Array(31);
    const failedDigest = async (): Promise<Uint8Array> => {
      throw new TypeError("digest unavailable");
    };

    // When and Then each provider is used
    await expect(
      hashDatabaseScopeV1(
        { principalId: "principal-a", tenantId: "tenant-a" },
        shortDigest,
      ),
    ).rejects.toMatchObject({ code: "DIGEST_UNAVAILABLE" });
    await expect(
      hashDatabaseScopeV1(
        { principalId: "principal-a", tenantId: "tenant-a" },
        failedDigest,
      ),
    ).rejects.toBeInstanceOf(DatabaseConnectorErrorV2);
  });
});
