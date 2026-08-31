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
    };
    prepareConfigMock.mockResolvedValue({ config: { signing } });
    inspectBundleSigningMock.mockResolvedValue({
      algorithm: "RSA-SHA256",
      provider: "Local file",
      status: "enabled",
    });

    const result = await getBundleSigningInspection();

    expect(prepareConfigMock).toHaveBeenCalledOnce();
    expect(inspectBundleSigningMock).toHaveBeenCalledWith(signing);
    expect(result).toEqual({
      algorithm: "RSA-SHA256",
      provider: "Local file",
      status: "enabled",
    });
  });
});
