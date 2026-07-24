import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import {
  attachCapabilityContribution,
  type CapabilityContribution,
  defineCapability,
  getCapabilityContributions,
  type HotUpdaterInfrastructureRuntime,
  InvalidCapabilityCarrierError,
} from "./capabilities";
import { createDatabasePlugin } from "./createDatabasePlugin";

class UnexpectedDatabaseOperationError extends Error {}
class MissingCapabilityContributionError extends Error {}

const unimplemented = async (): Promise<never> => {
  throw new UnexpectedDatabaseOperationError();
};

const createRuntime = (): HotUpdaterInfrastructureRuntime =>
  Object.freeze({
    database: Object.freeze(
      createDatabasePlugin({
        name: "guarded-database",
        plugin: () => ({
          create: unimplemented,
          update: unimplemented,
          delete: unimplemented,
          count: unimplemented,
          findOne: unimplemented,
          findMany: unimplemented,
        }),
      }),
    ),
    storages: Object.freeze([]),
  });

describe("capability tokens", () => {
  it("creates distinct frozen tokens for the same observable id", () => {
    // Given
    const options = {
      id: "example@1",
      parse: (value: unknown) => String(value),
    } as const;

    // When
    const first = defineCapability(options);
    const second = defineCapability(options);

    // Then
    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it("does not expose its compile-time-only nominal brand at runtime", () => {
    // Given
    const token = defineCapability({
      id: "cross-package@1",
      parse: (value: unknown) => String(value),
    });

    // When
    const keys = Reflect.ownKeys(token);

    // Then
    expect(keys).toEqual(["id", "parse"]);
  });

  it("rejects a token forged with the former process-wide brand", () => {
    // Given
    const forgedToken = {
      [Symbol.for("@hot-updater/plugin-core/capability-token")]: undefined,
      id: "forged@1",
      parse: (value: unknown) => String(value),
    };

    // When
    const attach = () =>
      Reflect.apply(attachCapabilityContribution, undefined, [
        { name: "database" },
        { token: forgedToken, create: () => "forged" },
      ]);

    // Then
    expect(attach).toThrow(InvalidCapabilityCarrierError);
  });

  it("rejects a token forged by inheriting from a genuine token", () => {
    // Given
    const genuineToken = defineCapability({
      id: "genuine@1",
      parse: (value: unknown) => String(value),
    });
    const forgedToken = Object.defineProperties(Object.create(genuineToken), {
      id: {
        value: "forged-from-genuine@1",
      },
      parse: {
        value: (value: unknown) => String(value),
      },
    });

    // When
    const attach = () =>
      Reflect.apply(attachCapabilityContribution, undefined, [
        { name: "database" },
        { token: forgedToken, create: () => "forged" },
      ]);

    // Then
    expect(attach).toThrow(InvalidCapabilityCarrierError);
  });
});

describe("capability package boundary", () => {
  it("publishes a narrow unsupported enumeration subpath", () => {
    // Given
    const internalExport: unknown = Reflect.get(
      packageJson.exports,
      "./internal/capabilities",
    );

    // When
    const published = internalExport;

    // Then
    expect(published).toEqual({
      import: {
        types: "./dist/internal/capabilities.d.mts",
        default: "./dist/internal/capabilities.mjs",
      },
      require: {
        types: "./dist/internal/capabilities.d.cts",
        default: "./dist/internal/capabilities.cjs",
      },
    });
  });
});

describe("capability contribution carriers", () => {
  it("ignores contributions forged with the former process-wide key", () => {
    // Given
    const forgedCarrier = {};
    Object.defineProperty(
      forgedCarrier,
      Symbol.for("@hot-updater/plugin-core/capability-contributions"),
      {
        value: [
          {
            token: defineCapability({
              id: "forged-carrier@1",
              parse: (value: unknown) => String(value),
            }),
            create: () => "forged",
          },
        ],
      },
    );

    // When
    const contributions = getCapabilityContributions(forgedCarrier);

    // Then
    expect(contributions).toEqual([]);
  });

  it("preserves a prototype carrier and all of its own members", () => {
    // Given
    const marker = Symbol("marker");
    class PrototypeCarrier {
      readonly #secret = "private-state";

      readSecret() {
        return this.#secret;
      }
    }
    const carrier = new PrototypeCarrier();
    Object.defineProperty(carrier, "hidden", {
      enumerable: false,
      value: "non-enumerable",
    });
    Reflect.set(carrier, marker, "symbol-value");

    // When
    const attached = attachCapabilityContribution(carrier, {
      token: defineCapability({
        id: "prototype@1",
        parse: (value: unknown) => String(value),
      }),
      create: () => "prototype",
    });

    // Then
    expect(attached).not.toBe(carrier);
    expect(attached).toBeInstanceOf(PrototypeCarrier);
    expect(Object.getPrototypeOf(attached)).toBe(
      Object.getPrototypeOf(carrier),
    );
    expect(attached.readSecret()).toBe("private-state");
    expect(Reflect.get(attached, "hidden")).toBe("non-enumerable");
    expect(Reflect.get(attached, marker)).toBe("symbol-value");
    expect(Reflect.ownKeys(attached)).toEqual(Reflect.ownKeys(carrier));
    expect(
      Reflect.getOwnPropertyDescriptor(attached, "hidden")?.enumerable,
    ).toBe(false);
    expect(getCapabilityContributions(carrier)).toEqual([]);
    expect(getCapabilityContributions(attached)).toHaveLength(1);
  });

  it("attaches a contribution without mutating the input carrier", () => {
    // Given
    const carrier = Object.freeze({ name: "database" });
    const contribution = {
      token: defineCapability({
        id: "first@1",
        parse: (value: unknown) => String(value),
      }),
      create: () => "first",
    } satisfies CapabilityContribution<string>;

    // When
    const attached = attachCapabilityContribution(carrier, contribution);

    // Then
    expect(attached).not.toBe(carrier);
    expect(attached).toEqual(carrier);
    expect(Object.isFrozen(attached)).toBe(true);
    expect(getCapabilityContributions(carrier)).toEqual([]);
    expect(getCapabilityContributions(attached)).toHaveLength(1);
  });

  it("uses frozen copy-on-write contribution snapshots", () => {
    // Given
    const carrier = { name: "database" };
    const first = {
      token: defineCapability({
        id: "first@1",
        parse: (value: unknown) => String(value),
      }),
      create: () => "first",
    } satisfies CapabilityContribution<string>;
    const second = {
      token: defineCapability({
        id: "second@1",
        parse: (value: unknown) => Number(value),
      }),
      create: () => 2,
    } satisfies CapabilityContribution<number>;
    const firstCarrier = attachCapabilityContribution(carrier, first);
    const firstSnapshot = getCapabilityContributions(firstCarrier);

    // When
    const secondCarrier = attachCapabilityContribution(firstCarrier, second);

    // Then
    const secondSnapshot = getCapabilityContributions(secondCarrier);
    expect(firstCarrier).not.toBe(secondCarrier);
    expect(firstSnapshot).toHaveLength(1);
    expect(secondSnapshot).toHaveLength(2);
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(Object.isFrozen(secondSnapshot)).toBe(true);
    expect(secondSnapshot.every(Object.isFrozen)).toBe(true);
  });

  it("isolates independent attachments from the same original carrier", () => {
    // Given
    const carrier = Object.freeze({ name: "database" });
    const firstToken = defineCapability({
      id: "first-isolated@1",
      parse: (value: unknown) => String(value),
    });
    const secondToken = defineCapability({
      id: "second-isolated@1",
      parse: (value: unknown) => String(value),
    });

    // When
    const firstCarrier = attachCapabilityContribution(carrier, {
      token: firstToken,
      create: () => "first",
    });
    const secondCarrier = attachCapabilityContribution(carrier, {
      token: secondToken,
      create: () => "second",
    });

    // Then
    expect(firstCarrier).not.toBe(secondCarrier);
    expect(getCapabilityContributions(carrier)).toEqual([]);
    expect(
      getCapabilityContributions(firstCarrier).map(({ token }) => token.id),
    ).toEqual(["first-isolated@1"]);
    expect(
      getCapabilityContributions(secondCarrier).map(({ token }) => token.id),
    ).toEqual(["second-isolated@1"]);
  });

  it("keeps duplicate ids observable for kernel conflict detection", () => {
    // Given
    const firstToken = defineCapability({
      id: "duplicate@1",
      parse: (value: unknown) => String(value),
    });
    const secondToken = defineCapability({
      id: "duplicate@1",
      parse: (value: unknown) => Number(value),
    });
    const firstCarrier = attachCapabilityContribution(
      { name: "database" },
      { token: firstToken, create: () => "first" },
    );

    // When
    const secondCarrier = attachCapabilityContribution(firstCarrier, {
      token: secondToken,
      create: () => 2,
    });

    // Then
    const contributions = getCapabilityContributions(secondCarrier);
    expect(contributions.map(({ token }) => token.id)).toEqual([
      "duplicate@1",
      "duplicate@1",
    ]);
    expect(contributions[0]?.token).not.toBe(contributions[1]?.token);
  });

  it("leaves a synchronous factory lazy for one kernel invocation", () => {
    // Given
    let invocationCount = 0;
    const attached = attachCapabilityContribution(
      { name: "database" },
      {
        token: defineCapability({
          id: "lazy@1",
          parse: (value: unknown) => String(value),
        }),
        create: (runtime) => {
          invocationCount += 1;
          return runtime.database.name;
        },
      },
    );
    const [contribution] = getCapabilityContributions(attached);
    if (!contribution) throw new MissingCapabilityContributionError();

    // When
    const value = contribution.create(createRuntime());

    // Then
    expect(value).toBe("guarded-database");
    expect(invocationCount).toBe(1);
    expect(value).not.toBeInstanceOf(Promise);
  });

  it("rejects a contribution without a callable factory", () => {
    // Given
    const malformed = {
      token: defineCapability({
        id: "malformed@1",
        parse: (value: unknown) => String(value),
      }),
      create: "not-a-function",
    };

    // When
    const attach = () =>
      Reflect.apply(attachCapabilityContribution, undefined, [
        { name: "database" },
        malformed,
      ]);

    // Then
    expect(attach).toThrow(InvalidCapabilityCarrierError);
  });
});
