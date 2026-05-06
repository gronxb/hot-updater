import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetNativeAppVersion, mockCli } = vi.hoisted(() => {
  const mockGetNativeAppVersion = vi.fn();
  const mockCli = {
    p: {
      log: {
        message: vi.fn(),
      },
    },
  };
  return { mockGetNativeAppVersion, mockCli };
});

vi.mock("../utils/version/getNativeAppVersion", () => ({
  getNativeAppVersion: mockGetNativeAppVersion,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: mockCli.p,
  };
});

describe("handleAppVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNativeAppVersion.mockImplementation((platform: string) =>
      Promise.resolve(platform === "android" ? "1.2.3" : "2.3.4"),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints human-readable app versions by default", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { handleAppVersion } = await import("./appVersion");
    await handleAppVersion();

    expect(mockGetNativeAppVersion).toHaveBeenCalledWith("android");
    expect(mockGetNativeAppVersion).toHaveBeenCalledWith("ios");
    expect(mockCli.p.log.message).toHaveBeenCalledWith(
      expect.stringContaining("App version"),
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("prints raw JSON when --json is passed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { handleAppVersion } = await import("./appVersion");
    await handleAppVersion({ json: true });

    expect(mockCli.p.log.message).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ android: "1.2.3", ios: "2.3.4" }, null, 2),
    );
  });

  it("keeps missing platform versions explicit in JSON", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetNativeAppVersion.mockImplementation((platform: string) =>
      Promise.resolve(platform === "android" ? null : "2.3.4"),
    );

    const { handleAppVersion } = await import("./appVersion");
    await handleAppVersion({ json: true });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ android: null, ios: "2.3.4" }, null, 2),
    );
  });
});
