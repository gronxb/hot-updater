// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { inspectBundleSigningMock, prepareConfigMock } = vi.hoisted(() => ({
  inspectBundleSigningMock: vi.fn(),
  prepareConfigMock: vi.fn(),
}));

vi.mock("./server/config.server", () => ({
  prepareConfig: prepareConfigMock,
}));

vi.mock("./server/bundle-signing.server", () => ({
  inspectBundleSigning: inspectBundleSigningMock,
}));

import { getBundleSigningInspection } from "./bundle-signing-rpc";

describe("bundle signing RPC", () => {
  beforeEach(() => {
    inspectBundleSigningMock.mockReset();
    prepareConfigMock.mockReset();
  });

  it("authenticates through prepared config and returns only the inspection DTO", async () => {
    const signing = {
      enabled: true,
      provider: "Local file",
      publicKeyPath: "keys/public-key.pem",
    };
    prepareConfigMock.mockResolvedValue({ config: { signing } });
    inspectBundleSigningMock.mockResolvedValue({
      algorithm: "RSA-SHA256",
      fingerprint: "a".repeat(64),
      provider: "Local file",
      publicKey: "public-key",
      status: "enabled",
    });

    const result = await getBundleSigningInspection();

    expect(prepareConfigMock).toHaveBeenCalledOnce();
    expect(inspectBundleSigningMock).toHaveBeenCalledWith(signing);
    expect(result).toEqual({
      algorithm: "RSA-SHA256",
      fingerprint: "a".repeat(64),
      provider: "Local file",
      publicKey: "public-key",
      status: "enabled",
    });
    expect(result).not.toHaveProperty("publicKeyPath");
  });
});
