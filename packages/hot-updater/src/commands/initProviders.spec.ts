import * as awsInit from "@hot-updater/aws/init";
import * as azureInit from "@hot-updater/azure/init";
import * as cloudflareInit from "@hot-updater/cloudflare/init";
import * as firebaseInit from "@hot-updater/firebase/init";
import * as supabaseInit from "@hot-updater/supabase/init";
import * as vercelInit from "@hot-updater/vercel/init";
import { describe, expect, it } from "vitest";

import {
  INIT_PROVIDER_NAMES,
  INIT_PROVIDER_PACKAGES,
  isInitProvider,
} from "./initProviders";

const providerInits = {
  aws: awsInit,
  azure: azureInit,
  cloudflare: cloudflareInit,
  firebase: firebaseInit,
  supabase: supabaseInit,
  vercel: vercelInit,
};

describe("init provider packages", () => {
  it("derives provider guards from the package registry", () => {
    // Given
    const declaredProviders = [
      "cloudflare",
      "aws",
      "supabase",
      "firebase",
      "vercel",
      "azure",
    ];

    // When
    const results = declaredProviders.map(isInitProvider);

    // Then
    expect(INIT_PROVIDER_NAMES).toEqual(declaredProviders);
    expect(results).toEqual(declaredProviders.map(() => true));
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
});
