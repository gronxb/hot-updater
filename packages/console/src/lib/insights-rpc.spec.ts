// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInstallation: vi.fn(),
  pageInstallations: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator() {
      return this;
    },
    handler(handler: (input: unknown) => unknown) {
      return handler;
    },
  }),
}));

vi.mock("./server/config.server", () => ({
  prepareConfig: async () => ({
    hotUpdater: {
      getInstallation: mocks.getInstallation,
      pageInstallationsByCurrentUserId: mocks.pageInstallations,
    },
  }),
}));

import { findInsightsInstallationsRpc } from "./insights-rpc";

const installation = {
  appVersion: "1.4.2",
  channel: "production",
  cohort: "cohort-a",
  installId: "install-1",
  lastKnownBundleId: "bundle-b",
  latestStatus: "UPDATE_APPLIED" as const,
  platform: "ios" as const,
  receivedAtMs: 100,
  userId: "user-1",
  username: "ada",
};

describe("findInsightsInstallationsRpc", () => {
  beforeEach(() => vi.clearAllMocks());

  it("combines an exact installation with current-user matches without duplicates", async () => {
    mocks.getInstallation.mockResolvedValue(installation);
    mocks.pageInstallations.mockResolvedValue({
      data: [installation, { ...installation, installId: "install-2" }],
      nextCursor: "next-user-page",
    });

    const result = await findInsightsInstallationsRpc({
      data: { identity: "install-1", limit: 20 },
    });

    expect(mocks.getInstallation).toHaveBeenCalledWith({
      installId: "install-1",
    });
    expect(mocks.pageInstallations).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 19,
      userId: "install-1",
    });
    expect(result).toEqual({
      data: [installation, { ...installation, installId: "install-2" }],
      nextCursor: "next-user-page",
    });
  });

  it("uses only the user cursor after the first result page", async () => {
    mocks.pageInstallations.mockResolvedValue({ data: [], nextCursor: null });

    await findInsightsInstallationsRpc({
      data: { cursor: "user-cursor", identity: "user-1", limit: 20 },
    });

    expect(mocks.getInstallation).not.toHaveBeenCalled();
    expect(mocks.pageInstallations).toHaveBeenCalledWith({
      cursor: "user-cursor",
      limit: 20,
      userId: "user-1",
    });
  });
});
