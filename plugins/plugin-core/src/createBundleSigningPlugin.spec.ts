import { describe, expect, expectTypeOf, it } from "vitest";

import { createBundleSigningPlugin } from "./createBundleSigningPlugin";
import type { BundleSigningPlugin, SigningConfig } from "./types";

const provider = createBundleSigningPlugin({
  name: "test",
  publicKeyPath: "public-key.pem",
  getPublicKey: async () => ({ publicKey: "public-key" }),
  sign: async ({ message }) => ({ signature: message }),
});

describe("createBundleSigningPlugin", () => {
  it("preserves the concrete plugin type", () => {
    expect(provider.name).toBe("test");
    expectTypeOf(provider).toMatchTypeOf<BundleSigningPlugin>();
  });

  it("uses the plugin directly as signing config", () => {
    expectTypeOf(provider).toMatchTypeOf<SigningConfig>();

    // @ts-expect-error signing plugins require a pinned public key path
    const missingPublicKey: SigningConfig = {
      name: "missing-public-key",
      getPublicKey: async () => ({ publicKey: "public-key" }),
      sign: async ({ message }) => ({ signature: message }),
    };

    expect(missingPublicKey.name).toBe("missing-public-key");
  });
});
