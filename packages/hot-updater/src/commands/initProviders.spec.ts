import { initProvider as awsInitProvider } from "@hot-updater/aws/init";
import { initProvider as cloudflareInitProvider } from "@hot-updater/cloudflare/init";
import { initProvider as firebaseInitProvider } from "@hot-updater/firebase/init";
import { initProvider as supabaseInitProvider } from "@hot-updater/supabase/init";
import { describe, expect, it } from "vitest";

import {
  INIT_PROVIDER_NAMES,
  INIT_PROVIDER_PACKAGES,
  isInitProvider,
} from "./initProviders";

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
});
