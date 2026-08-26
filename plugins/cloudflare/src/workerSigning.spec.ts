import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRemoteBundleSigningPlugin: vi.fn((options) => ({
    getPublicKey: vi.fn(),
    name: options.name,
    publicKeyPath: options.publicKeyPath,
    sign: vi.fn(),
  })),
}));

vi.mock("@hot-updater/plugin-core/internal", () => ({
  createRemoteBundleSigningPlugin: mocks.createRemoteBundleSigningPlugin,
}));

import { workerSigning } from "./workerSigning";

describe("workerSigning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HOT_UPDATER_CLOUDFLARE_SIGNING_TOKEN;
  });

  it("configures the remote signer with the Cloudflare Worker identity", () => {
    const signing = workerSigning({
      publicKeyPath: "./keys/public-key.pem",
      signingToken: "signing-token",
      workerUrl: "https://hot-updater.example.workers.dev",
    });

    expect(signing).toMatchObject({
      name: "cloudflareWorkerSigning",
      publicKeyPath: "./keys/public-key.pem",
    });
    expect(mocks.createRemoteBundleSigningPlugin).toHaveBeenCalledWith({
      endpoint: "https://hot-updater.example.workers.dev",
      name: "cloudflareWorkerSigning",
      publicKeyPath: "./keys/public-key.pem",
      resolveToken: expect.any(Function),
    });
  });

  it("resolves the explicit signing token lazily", () => {
    workerSigning({
      publicKeyPath: "./keys/public-key.pem",
      signingToken: "explicit-token",
      workerUrl: "https://hot-updater.example.workers.dev",
    });
    const { resolveToken } =
      mocks.createRemoteBundleSigningPlugin.mock.calls[0]![0];

    expect(resolveToken()).toBe("explicit-token");
  });

  it("falls back to the Cloudflare signing token environment variable lazily", () => {
    workerSigning({
      publicKeyPath: "./keys/public-key.pem",
      workerUrl: "https://hot-updater.example.workers.dev",
    });
    const { resolveToken } =
      mocks.createRemoteBundleSigningPlugin.mock.calls[0]![0];
    process.env.HOT_UPDATER_CLOUDFLARE_SIGNING_TOKEN = "environment-token";

    expect(resolveToken()).toBe("environment-token");
  });

  it("rejects a missing signing token only when the provider is used", () => {
    workerSigning({
      publicKeyPath: "./keys/public-key.pem",
      workerUrl: "https://hot-updater.example.workers.dev",
    });
    const { resolveToken } =
      mocks.createRemoteBundleSigningPlugin.mock.calls[0]![0];

    expect(() => resolveToken()).toThrow(
      "Cloudflare Worker signing token is required.",
    );
  });
});
