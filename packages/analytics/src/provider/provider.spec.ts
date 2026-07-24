import {
  attachCapabilityContribution,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { analytics } from "../analytics";
import { createTestProvider } from "../testing/createTestProvider";
import {
  analyticsProviderToken,
  InvalidAnalyticsProviderError,
  withAnalyticsProvider,
} from "./index";

class UnimplementedDatabaseOperationError extends Error {
  readonly name = "UnimplementedDatabaseOperationError";
}

const unavailable = async (): Promise<never> => {
  throw new UnimplementedDatabaseOperationError();
};

const createDatabase = (): DatabasePlugin =>
  Object.freeze({
    name: "analytics-test",
    count: unavailable,
    create: unavailable,
    delete: unavailable,
    findMany: unavailable,
    findOne: unavailable,
    update: unavailable,
  });

describe("analyticsProviderToken", () => {
  it("parses and freezes a complete provider", () => {
    // Given
    const source = createTestProvider();

    // When
    const provider = analyticsProviderToken.parse(source);

    // Then
    expect(provider).toBe(source);
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it.each([
    {},
    { ...createTestProvider(), mode: "bounded" },
    { ...createTestProvider(), appendBundleEvent: undefined },
    { ...createTestProvider(), mode: "unsupported" },
  ])("rejects malformed provider %#", (candidate) => {
    // Given / When / Then
    expect(() => analyticsProviderToken.parse(candidate)).toThrowError(
      InvalidAnalyticsProviderError,
    );
  });
});

describe("withAnalyticsProvider", () => {
  it("preserves a class database with non-enumerable and symbol members", () => {
    // Given
    const marker = Symbol("database-marker");
    class PrototypeDatabase {
      readonly #secret = "private-database-state";
      readonly name = "prototype-database";
      readonly count: DatabasePlugin["count"] = unavailable;
      readonly create: DatabasePlugin["create"] = unavailable;
      readonly delete: DatabasePlugin["delete"] = unavailable;
      readonly findMany: DatabasePlugin["findMany"] = unavailable;
      readonly findOne: DatabasePlugin["findOne"] = unavailable;
      readonly update: DatabasePlugin["update"] = unavailable;

      readSecret() {
        return this.#secret;
      }
    }
    const database = new PrototypeDatabase();
    Object.defineProperty(database, "hidden", {
      enumerable: false,
      value: "non-enumerable",
    });
    Reflect.set(database, marker, "symbol-value");

    // When
    const wrapped = withAnalyticsProvider(database);

    // Then
    expect(wrapped).not.toBe(database);
    expect(wrapped).toBeInstanceOf(PrototypeDatabase);
    expect(wrapped.readSecret()).toBe("private-database-state");
    expect(Reflect.get(wrapped, "hidden")).toBe("non-enumerable");
    expect(Reflect.get(wrapped, marker)).toBe("symbol-value");
    expect(getCapabilityContributions(database)).toEqual([]);
    expect(getCapabilityContributions(wrapped)).toHaveLength(1);
  });

  it("attaches one deferred provider factory without running database work", () => {
    // Given
    const database = createDatabase();

    // When
    const wrapped = withAnalyticsProvider(database);
    const contributions = getCapabilityContributions(wrapped);

    // Then
    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.token).toBe(analyticsProviderToken);
    expect(Object.isFrozen(wrapped)).toBe(true);
  });

  it("creates the bounded provider only from the supplied runtime database", () => {
    // Given
    const sourceDatabase = createDatabase();
    const runtimeDatabase = createDatabase();
    const wrapped = withAnalyticsProvider(sourceDatabase);
    const contribution = getCapabilityContributions(wrapped)[0];
    if (contribution === undefined) {
      throw new InvalidAnalyticsProviderError();
    }

    // When
    const value = contribution.create({
      database: runtimeDatabase,
      storages: [],
    });
    const provider = analyticsProviderToken.parse(value);

    // Then
    expect(provider.mode).toBe("bounded");
    if (provider.mode !== "bounded") {
      throw new InvalidAnalyticsProviderError();
    }
    expect(provider.maxMatchingRows).toBe(50_000);
  });

  it("defers a custom provider factory and preserves its dedicated result", () => {
    // Given
    const database = createDatabase();
    const runtimeDatabase = createDatabase();
    const dedicated = createTestProvider();
    let factoryCalls = 0;

    // When
    const wrapped = withAnalyticsProvider(database, (runtime) => {
      factoryCalls += 1;
      expect(runtime.database).toBe(runtimeDatabase);
      return dedicated;
    });
    const contribution = getCapabilityContributions(wrapped)[0];
    if (contribution === undefined) {
      throw new InvalidAnalyticsProviderError();
    }

    // Then
    expect(factoryCalls).toBe(0);
    const provider = analyticsProviderToken.parse(
      contribution.create({ database: runtimeDatabase, storages: [] }),
    );
    expect(factoryCalls).toBe(1);
    expect(provider).toBe(dedicated);
    expect(provider.mode).toBe("dedicated");
    expect(withAnalyticsProvider(wrapped)).toBe(wrapped);
    expect(getCapabilityContributions(wrapped)).toHaveLength(1);
  });

  it("returns the same carrier when the same helper wraps it twice", () => {
    // Given
    const once = withAnalyticsProvider(createDatabase());

    // When
    const twice = withAnalyticsProvider(once);

    // Then
    expect(twice).toBe(once);
    expect(getCapabilityContributions(twice)).toHaveLength(1);
  });

  it("does not hide a manually attached duplicate provider", () => {
    // Given
    const manual = attachCapabilityContribution(createDatabase(), {
      token: analyticsProviderToken,
      create: () => createTestProvider(),
    });
    const wrapped = withAnalyticsProvider(manual);
    const manifest = analytics({ missingCapability: "error" });

    // When
    const construct = () =>
      createHotUpdater({
        database: wrapped,
        plugins: [manifest],
      });

    // Then
    expect(getCapabilityContributions(wrapped)).toHaveLength(2);
    expect(construct).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_CAPABILITY_PROVIDER" }),
    );
  });
});
