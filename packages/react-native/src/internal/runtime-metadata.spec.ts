import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInstallId: vi.fn(() => "install-123"),
  getPersistedUserIdentity: vi.fn(() => ({
    userId: "user-123",
    username: "alice",
  })),
  setUser: vi.fn(),
}));

vi.mock("../native", () => ({
  getInstallId: mocks.getInstallId,
  getPersistedUserIdentity: mocks.getPersistedUserIdentity,
  setUser: mocks.setUser,
}));

vi.mock("../sdkVersion", () => ({
  HOT_UPDATER_SDK_VERSION: "sdk-version",
}));

describe("internal runtime metadata", () => {
  beforeEach(() => {
    mocks.getInstallId.mockClear();
    mocks.getPersistedUserIdentity.mockClear();
    mocks.setUser.mockClear();
  });

  it("exposes install and SDK metadata", async () => {
    const { getInstallId, HOT_UPDATER_SDK_VERSION } =
      await import("./runtime-metadata");

    expect(getInstallId()).toBe("install-123");
    expect(HOT_UPDATER_SDK_VERSION).toBe("sdk-version");
  });

  it("reads persisted user identity", async () => {
    const { getPersistedUserIdentity } = await import("./runtime-metadata");

    expect(getPersistedUserIdentity()).toEqual({
      userId: "user-123",
      username: "alice",
    });
  });

  it("writes persisted user identity through the isolated alias", async () => {
    const { setPersistedUserIdentity } = await import("./runtime-metadata");

    setPersistedUserIdentity({ userId: "user-123", username: "alice" });
    setPersistedUserIdentity(null);

    expect(mocks.setUser).toHaveBeenNthCalledWith(1, {
      userId: "user-123",
      username: "alice",
    });
    expect(mocks.setUser).toHaveBeenNthCalledWith(2, null);
  });
});
