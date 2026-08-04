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
  it("creates distinct frozen nominal tokens for the same observable id", () => {
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
    expect(Reflect.ownKeys(first)).toEqual(["id", "parse"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
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
      id: { value: "forged-from-genuine@1" },
      parse: { value: (value: unknown) => String(value) },
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
  it("publishes only the internal capability enumeration subpath", () => {
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
  it("attaches frozen copy-on-write snapshots without mutating the carrier", () => {
    // Given
    const carrier = Object.freeze({ name: "database" });
    const first = {
      token: defineCapability({ id: "first@1", parse: String }),
      create: () => "first",
    } satisfies CapabilityContribution<string>;
    const second = {
      token: defineCapability({ id: "second@1", parse: Number }),
      create: () => 2,
    } satisfies CapabilityContribution<number>;

    // When
    const firstCarrier = attachCapabilityContribution(carrier, first);
    const firstSnapshot = getCapabilityContributions(firstCarrier);
    const secondCarrier = attachCapabilityContribution(firstCarrier, second);
    const secondSnapshot = getCapabilityContributions(secondCarrier);

    // Then
    expect(firstCarrier).not.toBe(carrier);
    expect(secondCarrier).not.toBe(firstCarrier);
    expect(Object.isFrozen(firstCarrier)).toBe(true);
    expect(Object.isFrozen(secondCarrier)).toBe(true);
    expect(getCapabilityContributions(carrier)).toEqual([]);
    expect(firstSnapshot).toHaveLength(1);
    expect(secondSnapshot).toHaveLength(2);
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
    expect(Object.isFrozen(secondSnapshot)).toBe(true);
    expect(secondSnapshot.every(Object.isFrozen)).toBe(true);
  });

  it("preserves prototype behavior while keeping private state immutable", () => {
    // Given
    class PrototypeCarrier {
      readonly #secret = "private-state";

      readSecret() {
        return this.#secret;
      }
    }
    const carrier = new PrototypeCarrier();

    // When
    const attached = attachCapabilityContribution(carrier, {
      token: defineCapability({ id: "prototype@1", parse: String }),
      create: () => "prototype",
    });

    // Then
    expect(attached).toBeInstanceOf(PrototypeCarrier);
    expect(attached.readSecret()).toBe("private-state");
    expect(Object.isFrozen(attached)).toBe(true);
  });

  it("keeps synchronous factories lazy", () => {
    // Given
    let invocationCount = 0;
    const attached = attachCapabilityContribution(
      { name: "database" },
      {
        token: defineCapability({ id: "lazy@1", parse: String }),
        create: (runtime) => {
          invocationCount += 1;
          return runtime.database.name;
        },
      },
    );
    const contribution = getCapabilityContributions(attached)[0];
    if (!contribution) throw new InvalidCapabilityCarrierError();

    // When
    const value = contribution.create(createRuntime());

    // Then
    expect(value).toBe("guarded-database");
    expect(invocationCount).toBe(1);
    expect(value).not.toBeInstanceOf(Promise);
  });

  it("ignores contributions forged with the former process-wide key", () => {
    // Given
    const forgedCarrier = {};
    Object.defineProperty(
      forgedCarrier,
      Symbol.for("@hot-updater/plugin-core/capability-contributions"),
      { value: [{ create: () => "forged" }] },
    );

    // When
    const contributions = getCapabilityContributions(forgedCarrier);

    // Then
    expect(contributions).toEqual([]);
  });
});
