import { describe, expect, expectTypeOf, it } from "vitest";

import { createBundleSigningPlugin } from "./createBundleSigningPlugin";
import type { BundleSigningPlugin, SigningConfig } from "./types";

const provider = createBundleSigningPlugin({
  name: "test",
  getPublicKey: async () => ({ publicKey: "public-key" }),
  sign: async ({ message }) => ({ signature: message }),
});

describe("createBundleSigningPlugin", () => {
  it("preserves the concrete plugin type", () => {
    expect(provider.name).toBe("test");
    expectTypeOf(provider).toMatchTypeOf<BundleSigningPlugin>();
  });

  it("accepts only one enabled signing source", () => {
    expectTypeOf<{
      enabled: true;
      privateKeyPath: string;
    }>().toMatchTypeOf<SigningConfig>();
    expectTypeOf<{
      enabled: true;
      provider: BundleSigningPlugin;
      publicKeyPath: string;
    }>().toMatchTypeOf<SigningConfig>();

    // @ts-expect-error provider signing requires a public key path
    const missingPublicKey: SigningConfig = { enabled: true, provider };
    // @ts-expect-error file and provider signing sources are mutually exclusive
    const conflictingSources: SigningConfig = {
      enabled: true,
      privateKeyPath: "private.pem",
      provider,
      publicKeyPath: "public.pem",
    };

    expect(missingPublicKey.enabled).toBe(true);
    expect(conflictingSources.enabled).toBe(true);
  });
});
