import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultResolver } from "./DefaultResolver";
import type { ResolverCheckUpdateParams } from "./types";

const defaultParams: ResolverCheckUpdateParams = {
  platform: "android",
  appVersion: "1.0.0",
  bundleId: "00000000-0000-0000-0000-000000000111",
  minBundleId: "00000000-0000-0000-0000-000000000000",
  channel: "production",
  updateStrategy: "appVersion",
  fingerprintHash: null,
  incremental: true,
};

describe("createDefaultResolver incremental route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns incremental payload when incremental endpoint is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: "incremental",
          full: {
            id: "00000000-0000-0000-0000-000000000222",
            shouldForceUpdate: false,
            message: null,
            status: "UPDATE",
            fileUrl: "https://example.com/bundle.zip",
            fileHash: "sig:full",
          },
          incremental: {
            fromBundleId: defaultParams.bundleId,
            toBundleId: "00000000-0000-0000-0000-000000000222",
            platform: "android",
            jsBundlePath: "index.android.bundle",
            contentBaseUrl:
              "https://example.com/hot-updater/incremental/content",
            patch: {
              hash: "a".repeat(64),
              signedHash: "sig:patch",
              sourceHash: "b".repeat(64),
              targetHash: "c".repeat(64),
              targetSignedHash: "sig:target",
            },
            files: [
              {
                path: "index.android.bundle",
                size: 10,
                hash: "c".repeat(64),
                signedHash: "sig:file",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resolver = createDefaultResolver("https://example.com/hot-updater");
    const result = await resolver.checkUpdate?.(defaultParams);

    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
    expect((result as { mode?: string }).mode).toBe("incremental");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/incremental/app-version/android/1.0.0/production/",
    );
  });

  it("falls back to legacy endpoint when incremental endpoint fails", async () => {
    const fullPayload = {
      id: "00000000-0000-0000-0000-000000000333",
      shouldForceUpdate: false,
      message: null,
      status: "UPDATE",
      fileUrl: "https://example.com/full.zip",
      fileHash: "sig:full",
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fullPayload), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const resolver = createDefaultResolver("https://example.com/hot-updater");
    const result = await resolver.checkUpdate?.(defaultParams);

    expect(result).toEqual(fullPayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/incremental/app-version/");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/app-version/");
  });

  it("returns null when incremental endpoint reports mode none", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: "none",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resolver = createDefaultResolver("https://example.com/hot-updater");
    const result = await resolver.checkUpdate?.(defaultParams);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
