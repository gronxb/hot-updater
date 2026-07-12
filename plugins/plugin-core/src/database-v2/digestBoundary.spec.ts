import { describe, expect, it } from "vitest";

import { hashDatabaseScopeV1 } from "./databaseIdentity";

const scope = { principalId: "principal-a", tenantId: "tenant-a" };

describe("SHA-256 provider result boundary", () => {
  it("does not use Number.prototype.toString to format digest bytes", async () => {
    // Given a provider that installs a hostile numeric formatter
    const originalToString = Number.prototype.toString;
    let hookCalls = 0;

    // When provider-time mutation precedes source-boundary formatting
    let identity: string;
    try {
      identity = await hashDatabaseScopeV1(scope, async () => {
        Object.defineProperty(Number.prototype, "toString", {
          configurable: true,
          writable: true,
          value: function (radix?: number) {
            if (radix === 16) {
              hookCalls += 1;
              return "number-hook";
            }
            return Reflect.apply(originalToString, this, [radix]);
          },
        });
        return new Uint8Array(32);
      });
    } finally {
      Object.defineProperty(Number.prototype, "toString", {
        configurable: true,
        writable: true,
        value: originalToString,
      });
    }

    // Then mutable prototype hooks cannot corrupt the lowercase digest text
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
    expect(hookCalls).toBe(0);
  });

  it("does not use String.prototype.padStart to format digest bytes", async () => {
    // Given a provider that installs a hostile string formatter
    const originalPadStart = String.prototype.padStart;
    let hookCalls = 0;

    // When provider-time mutation precedes source-boundary formatting
    let identity: string;
    try {
      identity = await hashDatabaseScopeV1(scope, async () => {
        Object.defineProperty(String.prototype, "padStart", {
          configurable: true,
          writable: true,
          value: function (length: number, fill?: string) {
            if (length === 2 && fill === "0") {
              hookCalls += 1;
              return "pad-hook";
            }
            return Reflect.apply(originalPadStart, this, [length, fill]);
          },
        });
        return new Uint8Array(32);
      });
    } finally {
      Object.defineProperty(String.prototype, "padStart", {
        configurable: true,
        writable: true,
        value: originalPadStart,
      });
    }

    // Then mutable prototype hooks cannot corrupt the lowercase digest text
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
    expect(hookCalls).toBe(0);
  });

  it("does not read the typed-array length prototype after provider validation", async () => {
    // Given a provider that installs a hostile typed-array length getter
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
    const originalLength = Object.getOwnPropertyDescriptor(
      typedArrayPrototype,
      "length",
    );
    if (originalLength === undefined) {
      throw new TypeError("typed-array length getter is unavailable");
    }
    let getterCalls = 0;

    // When provider-time mutation precedes source-boundary formatting
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

    // Then the validated 32-byte count determines the complete digest text
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
    expect(getterCalls).toBe(0);
  });

  it("does not resolve Reflect.apply after the digest provider returns", async () => {
    // Given a provider that installs a stateful Reflect.apply wrapper
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

    // Then the validated provider bytes remain the exact digest identity
    expect(identity).toBe(`sha256:${"5a".repeat(32)}`);
    expect(wrapperCalls).toBe(0);
  });

  it("does not resolve the Uint8Array constructor after the provider returns", async () => {
    // Given a valid digest created before its global constructor is replaced
    const constructorDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Uint8Array",
    );
    if (constructorDescriptor === undefined) {
      throw new TypeError("Uint8Array descriptor is unavailable");
    }
    const digest = new Uint8Array(32).fill(0x5a);
    let constructorCalls = 0;

    // When provider-time mutation precedes snapshot allocation
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

    // Then snapshot allocation preserves every validated provider byte
    expect(identity).toBe(`sha256:${"5a".repeat(32)}`);
    expect(constructorCalls).toBe(0);
  });

  it("copies subclass bytes without invoking iterator, species, or index hooks", async () => {
    // Given a valid 32-byte subclass with hostile dynamic access hooks
    let iteratorCalls = 0;
    let speciesCalls = 0;
    let indexCalls = 0;
    class HostileDigest extends Uint8Array {}
    Object.defineProperty(HostileDigest.prototype, Symbol.iterator, {
      configurable: true,
      value: function* () {
        iteratorCalls += 1;
        yield 999;
      },
    });
    Object.defineProperty(HostileDigest, Symbol.species, {
      configurable: true,
      get: () => {
        speciesCalls += 1;
        throw new RangeError("digest species accessed");
      },
    });
    Object.defineProperty(HostileDigest.prototype, "0", {
      configurable: true,
      get: () => {
        indexCalls += 1;
        throw new RangeError("digest index accessed");
      },
    });
    const digest = new HostileDigest(32);

    // When the provider result crosses the public identity boundary
    const identity = await hashDatabaseScopeV1(scope, async () => digest);

    // Then only intrinsic backing bytes determine the exact digest identity
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
    expect(iteratorCalls).toBe(0);
    expect(speciesCalls).toBe(0);
    expect(indexCalls).toBe(0);
  });

  it("ignores an own iterator on an ordinary typed array", async () => {
    // Given a valid 32-byte typed array whose own iterator yields invalid bytes
    let iteratorCalls = 0;
    const digest = new Uint8Array(32);
    Object.defineProperty(digest, Symbol.iterator, {
      configurable: true,
      value: function* () {
        iteratorCalls += 1;
        yield -1;
      },
    });

    // When the provider result is encoded
    const identity = await hashDatabaseScopeV1(scope, async () => digest);

    // Then it remains exactly one lowercase 32-byte SHA-256 representation
    expect(identity).toBe(`sha256:${"00".repeat(32)}`);
    expect(identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(iteratorCalls).toBe(0);
  });
});
