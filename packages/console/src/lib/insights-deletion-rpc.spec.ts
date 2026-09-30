// @vitest-environment node

import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteInstallation: vi.fn(),
  deleteUser: vi.fn(),
  deletionOn: true,
}));

vi.mock("@tanstack/react-start", () => ({
  // The access middleware runs in the server; these specs call handlers directly.
  createMiddleware: () => ({ server: () => ({}) }),
  createServerFn: () => ({
    middleware() {
      return this;
    },
    validator(validator: (input: unknown) => unknown) {
      return {
        ...this,
        handler:
          (handler: (input: { data: unknown }) => unknown) =>
          (input: { data: unknown }) =>
            handler({ data: validator(input.data) }),
      };
    },
  }),
}));

vi.mock("./server/config.server", () => ({
  prepareConfig: async () => ({
    runtime: {
      remote: true,
      features: async () => ({
        insights: true,
        insightsAnalytics: false,
        insightsDeletion: mocks.deletionOn,
        apiKeys: false,
      }),
      apis: {
        insightsDeletion: {
          deleteInstallation: mocks.deleteInstallation,
          deleteUser: mocks.deleteUser,
        },
      },
    },
  }),
}));

import {
  deleteInsightsDataRpc,
  readDeletionTarget,
} from "./insights-deletion-rpc";

// The server function imports the runtime module on its first call; load it
// here, so its import time is not charged to the first test's timeout.
beforeAll(() => import("./server/runtime.server"), 30_000);

const done = { deleted: { installations: 1, events: 2 }, complete: true };

describe("deleteInsightsDataRpc", () => {
  it("deletes an installation's or a user's data, one bounded batch a call", async () => {
    mocks.deleteInstallation.mockResolvedValue(done);
    mocks.deleteUser.mockResolvedValue(done);

    await expect(
      deleteInsightsDataRpc({ data: { installId: "install-1" } }),
    ).resolves.toEqual(done);
    expect(mocks.deleteInstallation).toHaveBeenCalledWith("install-1");

    await expect(
      deleteInsightsDataRpc({ data: { userId: "user-1" } }),
    ).resolves.toEqual(done);
    expect(mocks.deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("refuses while the console does not delete Insights data", async () => {
    mocks.deletionOn = false;
    try {
      await expect(
        deleteInsightsDataRpc({ data: { installId: "install-1" } }),
      ).rejects.toMatchObject({
        name: "ConsoleFeatureUnavailableError",
        feature: "insightsDeletion",
      });
    } finally {
      mocks.deletionOn = true;
    }
  });
});

describe("readDeletionTarget", () => {
  it("takes exactly one installation or one user", () => {
    expect(readDeletionTarget({ installId: "install-1" })).toEqual({
      installId: "install-1",
    });
    expect(readDeletionTarget({ userId: "user-1" })).toEqual({
      userId: "user-1",
    });
    for (const input of [
      {},
      null,
      "install-1",
      { installId: "install-1", userId: "user-1" },
      { installId: "  " },
      { userId: 1 },
      { userId: "x".repeat(256) },
    ]) {
      expect(() => readDeletionTarget(input)).toThrow(
        "Name one installation or one user to delete.",
      );
    }
  });
});
