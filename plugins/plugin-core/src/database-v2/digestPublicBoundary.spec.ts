import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { hashDatabaseScopeV1 } from "./index";

const scope = { principalId: "public-principal", tenantId: "public-tenant" };

describe("public SHA-256 provider result boundary", () => {
  it("encodes identity input without a host TextEncoder", async () => {
    // Given an ES2022 host without the optional TextEncoder platform API
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "TextEncoder",
    );
    let identity: string;

    // When a caller supplies the required SHA-256 implementation
    try {
      Reflect.deleteProperty(globalThis, "TextEncoder");
      identity = await hashDatabaseScopeV1(scope, () => new Uint8Array(32));
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(globalThis, "TextEncoder", descriptor);
      }
    }

    // Then hashing remains available without any undeclared host dependency
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
  });

  it("keeps the digest exact when the typed-array length prototype is mutated", async () => {
    // Given a public provider that installs a hostile typed-array length getter
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const originalLength = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "length",
    );
    if (originalLength === undefined) {
      throw new TypeError("typed-array length getter is unavailable");
    }
    let getterCalls = 0;

    // When provider-time mutation precedes public-boundary formatting
    let identity: string;
    try {
      identity = await hashDatabaseScopeV1(scope, async () => {
        Object.defineProperty(typedArrayPrototype, "length", {
          configurable: true,
          get: () => {
            getterCalls += 1;
            return 0;
          },
        });
        return new Uint8Array(32);
      });
    } finally {
      Object.defineProperty(typedArrayPrototype, "length", originalLength);
    }

    // Then the public contract remains one exact lowercase SHA-256 digest
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
    expect(getterCalls).toBe(0);
  });

  it("keeps the public digest exact when Reflect.apply is stateful", async () => {
    // Given a public provider that installs a stateful Reflect.apply wrapper
    const originalApplyDescriptor = Object.getOwnPropertyDescriptor(
      Reflect,
      "apply",
    );
    if (originalApplyDescriptor === undefined) {
      throw new TypeError("Reflect.apply descriptor is unavailable");
    }
    const originalApply = Reflect.apply;
    let wrapperCalls = 0;

    // When the third live lookup suppresses the intrinsic digest copy
    let identity: string;
    try {
      identity = await hashDatabaseScopeV1(scope, async () => {
        Object.defineProperty(Reflect, "apply", {
          ...originalApplyDescriptor,
          value: (...parameters: Parameters<typeof Reflect.apply>) => {
            wrapperCalls += 1;
            if (wrapperCalls === 3) {
              return undefined;
            }
            return originalApply(...parameters);
          },
        });
        return new Uint8Array(32).fill(0x5a);
      });
    } finally {
      Object.defineProperty(Reflect, "apply", originalApplyDescriptor);
    }

    // Then the public boundary returns every validated provider byte exactly
    expect(identity).toBe(`sha256:${"5a".repeat(32)}`);
    expect(wrapperCalls).toBe(0);
  });

  it("keeps the public digest exact when global Uint8Array is replaced", async () => {
    // Given a public provider result created before constructor replacement
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Uint8Array",
    );
    if (constructorDescriptor === undefined) {
      throw new TypeError("Uint8Array descriptor is unavailable");
    }
    const digest = new Uint8Array(32).fill(0x5a);
    let constructorCalls = 0;

    // When the provider replaces the global constructor before returning
    let identity: string;
    try {
      identity = await hashDatabaseScopeV1(scope, async () => {
        Object.defineProperty(globalThis, "Uint8Array", {
          ...constructorDescriptor,
          value: function ThrowingUint8Array() {
            constructorCalls += 1;
            throw new RangeError("snapshot constructor intercepted");
          },
        });
        return digest;
      });
    } finally {
      Object.defineProperty(globalThis, "Uint8Array", constructorDescriptor);
    }

    // Then the public boundary preserves the exact digest without interception
    expect(identity).toBe(`sha256:${"5a".repeat(32)}`);
    expect(constructorCalls).toBe(0);
  });

  it("copies cross-realm subclass bytes without dynamic collection hooks", async () => {
    // Given a cross-realm subclass with hostile iterator, species, and index hooks
    const fixture = runInNewContext(`(() => {
      const calls = { index: 0, iterator: 0, species: 0 };
      class HostileDigest extends Uint8Array {}
      Object.defineProperty(HostileDigest.prototype, Symbol.iterator, {
        configurable: true,
        value: function* () {
          calls.iterator += 1;
          yield 999;
        },
      });
      Object.defineProperty(HostileDigest, Symbol.species, {
        configurable: true,
        get: () => {
          calls.species += 1;
          throw new RangeError("digest species accessed");
        },
      });
      Object.defineProperty(HostileDigest.prototype, "0", {
        configurable: true,
        get: () => {
          calls.index += 1;
          throw new RangeError("digest index accessed");
        },
      });
      return { calls, digest: new HostileDigest(32) };
    })()`);

    // When the result crosses the public source boundary
    const identity = await Reflect.apply(hashDatabaseScopeV1, undefined, [
      scope,
      async () => Reflect.get(fixture, "digest"),
    ]);
    const calls = Reflect.get(fixture, "calls");

    // Then intrinsic backing bytes alone determine the exact digest identity
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
    expect(Reflect.get(calls, "iterator")).toBe(0);
    expect(Reflect.get(calls, "species")).toBe(0);
    expect(Reflect.get(calls, "index")).toBe(0);
  });
});
