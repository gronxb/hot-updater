import { MAX_COMPILED_CATALOG_BYTES } from "@hot-updater/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpClient } from "./httpClient";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const state = {
  platform: "ios" as const,
  channel: "production",
  channelKey: "cHJvZHVjdGlvbg",
  appVersion: "1.2.3+4",
};
const catalog = {
  schemaVersion: 1,
  catalogId: "catalog",
  scopeKey: "v1:app-version:ios:cHJvZHVjdGlvbg",
  generation: 1,
  catalogHash: `sha256:${"a".repeat(64)}`,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  releases: [],
};

function respond(value: unknown) {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(value), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("Lynx delivery HTTP contract", () => {
  it("uses the existing encoded catalog route and forwards only configured request headers", async () => {
    const fetch = respond(catalog);
    const client = createHttpClient({
      baseURL: "https://updates.test/api/",
      requestHeaders: { Authorization: "test-header" },
    });
    await expect(client.fetchCatalog(state)).resolves.toEqual(catalog);
    expect(fetch).toHaveBeenCalledWith(
      "https://updates.test/api/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.2.3%2B4",
      expect.objectContaining({ headers: { Authorization: "test-header" } }),
    );
  });

  it("uses a native Unicode channel key when the runtime has no String.normalize", async () => {
    const channel = "프로덕션/β/Café";
    const channelKey = Buffer.from(channel, "utf8").toString("base64url");
    const unicodeState = { ...state, channel, channelKey };
    const unicodeCatalog = {
      ...catalog,
      scopeKey: `v1:app-version:ios:${channelKey}`,
    };
    const fetch = respond(unicodeCatalog);
    const normalize = Object.getOwnPropertyDescriptor(
      String.prototype,
      "normalize",
    )!;
    Object.defineProperty(String.prototype, "normalize", { value: undefined });
    try {
      await expect(
        createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(
          unicodeState,
        ),
      ).resolves.toEqual(unicodeCatalog);
      expect(fetch).toHaveBeenCalledWith(
        `https://updates.test/release-catalogs/app-version/ios/${channelKey}/1.2.3%2B4`,
        expect.anything(),
      );
    } finally {
      Object.defineProperty(String.prototype, "normalize", normalize);
    }
  });

  it("uses the fingerprint catalog route and scope when native supplies a hash", async () => {
    const fingerprintHash = "005a331297a3884be21fe8eddf7d3f0136145a28";
    const fingerprintCatalog = {
      ...catalog,
      scopeKey: `v1:fingerprint:ios:${state.channelKey}:${fingerprintHash}`,
    };
    const fetch = respond(fingerprintCatalog);
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(
        { ...state, fingerprintHash },
        "fingerprint",
      ),
    ).resolves.toEqual(fingerprintCatalog);
    expect(fetch).toHaveBeenCalledWith(
      `https://updates.test/release-catalogs/fingerprint/ios/${state.channelKey}/${fingerprintHash}`,
      expect.anything(),
    );
  });

  it.each([undefined, "", "../other", "key=", "a"])(
    "rejects malformed native channel key %s before making a request",
    async (channelKey) => {
      const fetch = respond(catalog);
      await expect(
        createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog({
          ...state,
          channelKey: channelKey as string,
        }),
      ).rejects.toMatchObject({ code: "INVALID_NATIVE_REPLY" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "/storage/bundle.tar.gz",
      "https://updates.test/api/storage/bundle.tar.gz",
    ],
    [
      "https://objects.test/bundle?signature=value",
      "https://objects.test/bundle?signature=value",
    ],
  ])(
    "resolves supported archive URL %s without changing signed hashes",
    async (fileUrl, expected) => {
      respond({
        fileUrl,
        fileHash: "sig:archive-signature",
        manifestFileHash: "sig:manifest-signature",
        changedAssets: { ignored: {} },
      });
      const result = await createHttpClient({
        baseURL: "https://updates.test/api",
      }).resolveArtifact("target", "running");
      expect(result).toEqual({
        bundleId: "target",
        fileUrl: expected,
        fileHash: "sig:archive-signature",
        manifestFileHash: "sig:manifest-signature",
      });
    },
  );

  it.each([
    "file:///tmp/archive",
    "//untrusted.test/archive",
    "/other/archive",
    "javascript:alert(1)",
  ])("rejects an unsupported artifact URL %s", async (fileUrl) => {
    respond({ fileUrl, fileHash: "a".repeat(64) });
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        "running",
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("does not invent a manifest hash for an archive-only server response", async () => {
    respond({
      fileUrl: "https://objects.test/archive",
      fileHash: "a".repeat(64),
    });
    expect(
      await createHttpClient({
        baseURL: "https://updates.test",
      }).resolveArtifact("target", "running"),
    ).toMatchObject({ manifestFileHash: null });
  });

  it("rejects a diff-only response because initial Lynx installation requires a full archive", async () => {
    respond({
      fileUrl: null,
      fileHash: null,
      manifestUrl: "/storage/manifest",
      changedAssets: {},
    });
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        "running",
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects an unexpected OS scope before native catalog acceptance", async () => {
    respond({ ...catalog, scopeKey: "v1:app-version:android:cHJvZHVjdGlvbg" });
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("bounds malformed catalog responses before parsing or selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(MAX_COMPILED_CATALOG_BYTES * 2 + 4097)),
      ),
    );
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Update response exceeds the size limit.",
    });
  });

  it("aborts a stalled HTTP request and returns a typed timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      ),
    );
    const request = createHttpClient({
      baseURL: "https://updates.test",
      requestTimeout: 20,
    }).fetchCatalog(state);
    const assertion = expect(request).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it("times out even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const request = createHttpClient({
      baseURL: "https://updates.test",
      requestTimeout: 20,
    }).fetchCatalog(state);
    const assertion = expect(request).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });
});
