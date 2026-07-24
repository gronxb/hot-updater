import { defineCapability } from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  defineFirstPartyFeatureManifest,
  isFirstPartyFeatureManifest,
  type FeatureApiKind,
  type HotUpdaterCapabilityRequirement,
  type ManifestAliases,
  type ManifestKind,
  type ManifestNamespace,
} from "./manifest";

type TestFeature<TContext> = Readonly<{
  readonly status: "available";
  readonly useContext: (context: TContext) => void;
}>;

type TestAvailableApi<TContext> = Readonly<{
  readonly useContext: (context: TContext) => void;
}>;

interface TestFeatureKind extends FeatureApiKind {
  readonly feature: TestFeature<this["context"]>;
  readonly availableApi: TestAvailableApi<this["context"]>;
}

describe("defineFirstPartyFeatureManifest", () => {
  it("creates a nominal frozen manifest with frozen aliases", () => {
    // Given
    const aliases = { legacyUseContext: "useContext" } as const;

    // When
    const manifest = defineFirstPartyFeatureManifest<
      "test-feature",
      TestFeatureKind,
      typeof aliases
    >({
      aliases,
      id: "test-feature",
      namespace: "test-feature",
      setup: () => ({}),
      version: "1.0.0",
    });

    // Then
    expect(isFirstPartyFeatureManifest(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.aliases)).toBe(true);
    expectTypeOf<
      ManifestNamespace<typeof manifest>
    >().toEqualTypeOf<"test-feature">();
    expectTypeOf<
      ManifestKind<typeof manifest>
    >().toEqualTypeOf<TestFeatureKind>();
    expectTypeOf<ManifestAliases<typeof manifest>>().toEqualTypeOf<
      typeof aliases
    >();
  });

  it("rejects a structurally similar object without the private brand", () => {
    // Given
    const structuralClone = {
      aliases: {},
      id: "clone",
      namespace: "clone",
      setup: () => ({}),
      version: "1.0.0",
    };

    // When / Then
    expect(isFirstPartyFeatureManifest(structuralClone)).toBe(false);
  });

  it("copies and freezes capability requirements", () => {
    // Given
    const requirement = {
      missing: "error",
      token: defineCapability({ id: "example@1", parse: String }),
    } satisfies HotUpdaterCapabilityRequirement;

    // When
    const manifest = defineFirstPartyFeatureManifest<
      "test-feature",
      TestFeatureKind,
      {}
    >({
      aliases: {},
      id: "test-feature",
      namespace: "test-feature",
      requires: [requirement],
      setup: () => ({}),
      version: "1.0.0",
    });
    Reflect.set(requirement, "missing", "continue");

    // Then
    expect(manifest.requires[0]?.missing).toBe("error");
    expect(Object.isFrozen(manifest.requires[0])).toBe(true);
  });
});
