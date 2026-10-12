import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveNativeAppVersion, mockCli } = vi.hoisted(() => {
  const mockResolveNativeAppVersion = vi.fn();
  const mockCli = {
    p: {
      log: {
        message: vi.fn(),
      },
    },
  };
  return { mockResolveNativeAppVersion, mockCli };
});

vi.mock("../utils/version/getNativeAppVersion", () => ({
  resolveNativeAppVersion: mockResolveNativeAppVersion,
}));

const resolved = (version: string | null) => ({
  version,
  candidates: version ? [{ label: "Info.plist", version }] : [],
});

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
    mockResolveNativeAppVersion.mockImplementation((platform: string) =>
      Promise.resolve(resolved(platform === "android" ? "1.2.3" : "2.3.4")),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints human-readable app versions by default", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { handleAppVersion } = await import("./appVersion");
    await handleAppVersion();

    expect(mockResolveNativeAppVersion).toHaveBeenCalledWith("android");
    expect(mockResolveNativeAppVersion).toHaveBeenCalledWith("ios");
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
    mockResolveNativeAppVersion.mockImplementation((platform: string) =>
      Promise.resolve(resolved(platform === "android" ? null : "2.3.4")),
    );

    const { handleAppVersion } = await import("./appVersion");
    await handleAppVersion({ json: true });

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ android: null, ios: "2.3.4" }, null, 2),
    );
  });

  it("lists every version when the native project builds several", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockResolveNativeAppVersion.mockImplementation((platform: string) =>
      Promise.resolve(
        platform === "android"
          ? resolved("1.2.3")
          : {
              version: null,
              candidates: [
                { label: "BrandA (Release)", version: "5.5.1" },
                { label: "BrandB (Release)", version: "5.8.0" },
              ],
            },
      ),
    );

    const { handleAppVersion } = await import("./appVersion");
    await handleAppVersion();
    await handleAppVersion({ json: true });

    expect(mockCli.p.log.message).toHaveBeenCalledWith(
      expect.stringContaining(
        "BrandA (Release): 5.5.1, BrandB (Release): 5.8.0",
      ),
    );
    // The JSON shape stays: no single version is null.
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ android: "1.2.3", ios: null }, null, 2),
    );
  });
});
