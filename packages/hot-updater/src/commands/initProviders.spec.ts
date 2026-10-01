import * as awsInit from "@hot-updater/aws/init";
import * as cloudflareInit from "@hot-updater/cloudflare/init";
import * as firebaseInit from "@hot-updater/firebase/init";
import * as supabaseInit from "@hot-updater/supabase/init";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INIT_PROVIDER_NAMES,
  INIT_PROVIDER_PACKAGES,
  isInitProvider,
  otherServerDefinitionsOf,
} from "./initProviders";

const providerInits = {
  aws: awsInit,
  cloudflare: cloudflareInit,
  firebase: firebaseInit,
  supabase: supabaseInit,
};

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

  it("loads each provider's whole init from its package's ./init entry", async () => {
    for (const name of INIT_PROVIDER_NAMES) {
      const module = await INIT_PROVIDER_PACKAGES[name].load();

      expect(module.initProvider, name).toBe(providerInits[name].initProvider);
      expect(module.runInit, name).toBe(providerInits[name].runInit);
    }
  });

  it("names each provider in init's prompt by its package's init label", () => {
    for (const name of INIT_PROVIDER_NAMES) {
      expect(INIT_PROVIDER_PACKAGES[name].label, name).toBe(
        providerInits[name].initProvider.label,
      );
    }
  });

  it("lists every server definition each provider's init writes", () => {
    for (const [pkg, { initProvider }, variants] of [
      ["@hot-updater/aws", awsInit, 4],
      ["@hot-updater/cloudflare", cloudflareInit, 1],
      ["@hot-updater/firebase", firebaseInit, 1],
      ["@hot-updater/supabase", supabaseInit, 1],
    ] as const) {
      const definitions = initProvider.serverDefinitions();
      // AWS writes one per credential mode.
      expect(new Set(definitions).size).toBe(variants);
      for (const text of definitions) {
        expect(text).toContain("export const hotUpdater = createHotUpdater({");
        expect(text).toMatch(new RegExp(`\\} from "${pkg}";`, "u"));
      }
    }
  });

  it("gives a provider's init the definitions of the other provider packages the project has installed", async () => {
    await expect(otherServerDefinitionsOf("cloudflare")).resolves.toEqual([
      ...awsInit.initProvider.serverDefinitions(),
      ...supabaseInit.initProvider.serverDefinitions(),
      ...firebaseInit.initProvider.serverDefinitions(),
    ]);
  });

  it("leaves out a provider whose package isn't installed, and init then refuses its definition from its imports", async () => {
    vi.spyOn(INIT_PROVIDER_PACKAGES.supabase, "load").mockRejectedValue(
      Object.assign(new Error("Cannot find package '@hot-updater/supabase'"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
    );

    await expect(otherServerDefinitionsOf("cloudflare")).resolves.toEqual([
      ...awsInit.initProvider.serverDefinitions(),
      ...firebaseInit.initProvider.serverDefinitions(),
    ]);
  });

  it("leaves out a provider whose definitions fail to render", async () => {
    vi.spyOn(supabaseInit.initProvider, "serverDefinitions").mockImplementation(
      () => {
        throw new Error("cannot render");
      },
    );

    await expect(otherServerDefinitionsOf("cloudflare")).resolves.toEqual([
      ...awsInit.initProvider.serverDefinitions(),
      ...firebaseInit.initProvider.serverDefinitions(),
    ]);
  });
});
