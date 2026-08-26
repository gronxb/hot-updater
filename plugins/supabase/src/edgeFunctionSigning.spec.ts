import { afterEach, describe, expect, it, vi } from "vitest";

import { edgeFunctionSigning } from "./edgeFunctionSigning";

const { createRemoteBundleSigningPlugin } = vi.hoisted(() => ({
  createRemoteBundleSigningPlugin: vi.fn((options) => ({
    getPublicKey: vi.fn(),
    name: options.name,
    publicKeyPath: options.publicKeyPath,
    sign: vi.fn(),
  })),
}));

vi.mock("@hot-updater/plugin-core/internal", () => ({
  createRemoteBundleSigningPlugin,
}));

describe("edgeFunctionSigning", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("creates the official Supabase signer and resolves its token lazily", async () => {
    const plugin = edgeFunctionSigning({
      functionUrl: "https://project.supabase.co/functions/v1/bundle-signer",
      publicKeyPath: "keys/bundle-signing-public.pem",
    });

    vi.stubEnv("HOT_UPDATER_SUPABASE_SIGNING_TOKEN", "deploy-only-token");
    const options = createRemoteBundleSigningPlugin.mock.calls[0][0];

    expect(plugin).toMatchObject({
      name: "supabaseEdgeFunctionSigning",
      publicKeyPath: "keys/bundle-signing-public.pem",
    });
    expect(options.endpoint).toBe(
      "https://project.supabase.co/functions/v1/bundle-signer",
    );
    expect(options.resolveToken()).toBe("deploy-only-token");
  });

  it("prefers an explicit dedicated token and rejects missing credentials", async () => {
    edgeFunctionSigning({
      functionUrl: "https://project.supabase.co/functions/v1/bundle-signer",
      publicKeyPath: "keys/public.pem",
      signingToken: "explicit-token",
    });
    let options = createRemoteBundleSigningPlugin.mock.calls[0][0];
    expect(options.resolveToken()).toBe("explicit-token");

    vi.clearAllMocks();
    vi.stubEnv("HOT_UPDATER_SUPABASE_SIGNING_TOKEN", "");
    edgeFunctionSigning({
      functionUrl: "https://project.supabase.co/functions/v1/bundle-signer",
      publicKeyPath: "keys/public.pem",
    });
    options = createRemoteBundleSigningPlugin.mock.calls[0][0];
    expect(() => options.resolveToken()).toThrow(
      "Supabase bundle signing requires signingToken or HOT_UPDATER_SUPABASE_SIGNING_TOKEN.",
    );
  });
});
