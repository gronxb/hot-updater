import { initProvider as awsInitProvider } from "@hot-updater/aws/init";
import { initProvider as cloudflareInitProvider } from "@hot-updater/cloudflare/init";
import { initProvider as firebaseInitProvider } from "@hot-updater/firebase/init";
import { initProvider as supabaseInitProvider } from "@hot-updater/supabase/init";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INIT_PROVIDER_NAMES,
  INIT_PROVIDER_PACKAGES,
  isInitProvider,
  otherServerDefinitionsOf,
} from "./initProviders";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("init provider packages", () => {
  it("derives provider guards from the package registry", () => {
    // Given
    const declaredProviders = ["cloudflare", "aws", "supabase", "firebase"];

    // When
    const results = declaredProviders.map(isInitProvider);

    // Then
    expect(INIT_PROVIDER_NAMES).toEqual(declaredProviders);
    expect(results).toEqual([true, true, true, true]);
    expect(isInitProvider("unknown")).toBe(false);
    expect(isInitProvider(undefined)).toBe(false);
  });

  it("uses each provider package's init definition", () => {
    // Given
    const providerPackages = INIT_PROVIDER_PACKAGES;

    // When
    const definitions = {
      aws: providerPackages.aws.definition,
      cloudflare: providerPackages.cloudflare.definition,
      firebase: providerPackages.firebase.definition,
      supabase: providerPackages.supabase.definition,
    };

    // Then
    expect(definitions.aws).toBe(awsInitProvider);
    expect(definitions.cloudflare).toBe(cloudflareInitProvider);
    expect(definitions.firebase).toBe(firebaseInitProvider);
    expect(definitions.supabase).toBe(supabaseInitProvider);
  });

  it("lists every server definition each provider's init writes, from the init entry the CLI inlines", () => {
    for (const [pkg, provider, variants] of [
      ["@hot-updater/aws", awsInitProvider, 4],
      ["@hot-updater/cloudflare", cloudflareInitProvider, 1],
      ["@hot-updater/firebase", firebaseInitProvider, 1],
      ["@hot-updater/supabase", supabaseInitProvider, 1],
    ] as const) {
      const definitions = provider.serverDefinitions();
      // AWS writes one per credential mode.
      expect(new Set(definitions).size).toBe(variants);
      for (const text of definitions) {
        expect(text).toContain("export const hotUpdater = createHotUpdater({");
        expect(text).toMatch(new RegExp(`\\} from "${pkg}";`, "u"));
      }
    }
  });

  it("gives a provider's init the other providers' definitions, leaving out one that fails to render", () => {
    const others = otherServerDefinitionsOf("cloudflare");

    expect(others).toEqual([
      ...awsInitProvider.serverDefinitions(),
      ...supabaseInitProvider.serverDefinitions(),
      ...firebaseInitProvider.serverDefinitions(),
    ]);

    // Init then refuses such a definition from its imports instead.
    vi.spyOn(supabaseInitProvider, "serverDefinitions").mockImplementation(
      () => {
        throw new Error("cannot render");
      },
    );
    expect(otherServerDefinitionsOf("cloudflare")).toEqual([
      ...awsInitProvider.serverDefinitions(),
      ...firebaseInitProvider.serverDefinitions(),
    ]);
  });
});
