import {
  MAX_COMPILED_CATALOG_BYTES,
  MAX_UPDATE_ARTIFACT_RESPONSE_BYTES,
} from "@hot-updater/core";
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
const baseBundleId = "00000000-0000-7000-8000-000000000001";
const archiveSignature = `sig:${Buffer.from("archive-signature").toString("base64")}`;
const manifestSignature = `sig:${Buffer.from("manifest-signature").toString("base64")}`;
const changedAsset = {
  fileHash: "b".repeat(64),
  file: { url: "/storage/native-entry.br", compression: "br" },
  patch: {
    algorithm: "bsdiff",
    baseBundleId,
    baseFileHash: "a".repeat(64),
    patchFileHash: "c".repeat(64),
    patchUrl: "https://objects.test/native-entry.patch?Signature=abc%2Fdef%3D",
  },
};
const manifestArtifact = {
  manifestUrl: "/storage/manifest.json",
  manifestFileHash: manifestSignature,
  changedAssets: { "native/entry.bin": changedAsset },
};
const maxResponseBytes = MAX_COMPILED_CATALOG_BYTES * 2 + 4096;

function respond(value: unknown) {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(value), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function artifactResponseBody(byteLength: number): string {
  const artifact = {
    fileUrl: "/storage/archive.zip",
    fileHash: archiveSignature,
    manifestUrl: "/storage/manifest.json",
    manifestFileHash: manifestSignature,
    changedAssets: {
      "native/entry.bin": {
        fileHash: "b".repeat(64),
        file: {
          url: "https://objects.test/native-entry?padding=",
          compression: null,
        },
        patch: null,
      },
    },
  };
  const paddingLength = byteLength - JSON.stringify(artifact).length;
  if (paddingLength < 0)
    throw new Error("Artifact response budget is too low.");
  artifact.changedAssets["native/entry.bin"].file.url += "x".repeat(
    paddingLength,
  );
  const body = JSON.stringify(artifact);
  if (body.length !== byteLength) throw new Error("Invalid artifact fixture.");
  return body;
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
        fileHash: archiveSignature,
        manifestFileHash: manifestSignature,
      });
      const result = await createHttpClient({
        baseURL: "https://updates.test/api",
      }).resolveArtifact("target", "running");
      expect(result).toEqual({
        bundleId: "target",
        fileUrl: expected,
        fileHash: archiveSignature,
        manifestUrl: null,
        manifestFileHash: manifestSignature,
        changedAssets: null,
      });
    },
  );

  it("accepts artifact metadata at the shared response limit with archive fallback", async () => {
    const body = artifactResponseBody(MAX_UPDATE_ARTIFACT_RESPONSE_BYTES);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const result = await createHttpClient({
      baseURL: "https://updates.test",
    }).resolveArtifact("target", baseBundleId);

    expect(result.fileUrl).toBe("https://updates.test/storage/archive.zip");
    expect(result.manifestUrl).toBe(
      "https://updates.test/storage/manifest.json",
    );
    expect(result.changedAssets?.["native/entry.bin"]?.file?.url).toMatch(
      /^https:\/\/objects\.test\/native-entry\?padding=x+$/,
    );
  });

  it("rejects artifact metadata above the shared response limit", async () => {
    const body = artifactResponseBody(MAX_UPDATE_ARTIFACT_RESPONSE_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        baseBundleId,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Update response exceeds the size limit.",
    });
  });

  it.each([
    "file:///tmp/archive",
    "//untrusted.test/archive",
    "/other/archive",
    "javascript:alert(1)",
    "https://user:password@objects.test/archive",
    "https://objects.test\\@other.test/archive",
    "https://objects.test:65536/archive",
    "https://objects.test/archive\nother",
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

  it.each([false, true])(
    "preserves manifest files and binary patches with archive fallback=%s",
    async (withArchive) => {
      respond({
        ...manifestArtifact,
        ...(withArchive
          ? { fileUrl: "/storage/archive.zip", fileHash: archiveSignature }
          : {}),
      });
      // Background scripting does not require a browser URL implementation.
      vi.stubGlobal("URL", undefined);
      await expect(
        createHttpClient({
          baseURL: "https://updates.test/api",
        }).resolveArtifact("target", baseBundleId),
      ).resolves.toEqual({
        bundleId: "target",
        fileUrl: withArchive
          ? "https://updates.test/api/storage/archive.zip"
          : null,
        fileHash: withArchive ? archiveSignature : null,
        manifestUrl: "https://updates.test/api/storage/manifest.json",
        manifestFileHash: manifestSignature,
        changedAssets: {
          "native/entry.bin": {
            ...changedAsset,
            file: {
              url: "https://updates.test/api/storage/native-entry.br",
              compression: "br",
            },
          },
        },
      });
    },
  );

  it("accepts the exact server manifest-only DTO with file-only and patch-only assets", async () => {
    respond({
      fileUrl: null,
      fileHash: null,
      manifestUrl: "/storage/manifest.json",
      manifestFileHash: manifestSignature,
      changedAssets: {
        "native/file.bin": {
          fileHash: "d".repeat(64),
          file: { url: "/storage/file.bin", compression: null },
          patch: null,
        },
        "native/patch.bin": {
          fileHash: "e".repeat(64),
          file: null,
          patch: changedAsset.patch,
        },
      },
    });

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        baseBundleId,
      ),
    ).resolves.toEqual({
      bundleId: "target",
      fileUrl: null,
      fileHash: null,
      manifestUrl: "https://updates.test/storage/manifest.json",
      manifestFileHash: manifestSignature,
      changedAssets: {
        "native/file.bin": {
          fileHash: "d".repeat(64),
          file: {
            url: "https://updates.test/storage/file.bin",
            compression: null,
          },
          patch: null,
        },
        "native/patch.bin": {
          fileHash: "e".repeat(64),
          file: null,
          patch: changedAsset.patch,
        },
      },
    });
  });

  it.each([
    {},
    { "native/entry.bin": { ...changedAsset, file: null } },
    {
      "assets/empty.txt": {
        fileHash: "d".repeat(64),
        file: { url: "/storage/empty.txt", compression: null },
        patch: null,
      },
    },
  ])(
    "accepts manifest updates with reusable or independently downloadable assets: %j",
    async (changedAssets) => {
      respond({ ...manifestArtifact, changedAssets });
      const result = await createHttpClient({
        baseURL: "https://updates.test",
      }).resolveArtifact("target", baseBundleId);
      expect(Object.keys(result.changedAssets!)).toEqual(
        Object.keys(changedAssets),
      );
      expect(result.fileUrl).toBeNull();
    },
  );

  it.each([
    ["missing archive hash", { fileUrl: "/storage/archive.zip" }],
    ["missing archive URL", { fileHash: "a".repeat(64) }],
    [
      "malformed archive hash",
      { fileUrl: "/storage/archive.zip", fileHash: "not-a-hash" },
    ],
    ["empty signature", { fileUrl: "/storage/archive.zip", fileHash: "sig:" }],
    [
      "invalid signature encoding",
      { fileUrl: "/storage/archive.zip", fileHash: "sig:not-base64" },
    ],
    ["missing manifest hash", { ...manifestArtifact, manifestFileHash: null }],
    ["missing manifest URL", { ...manifestArtifact, manifestUrl: null }],
    ["missing changed map", { ...manifestArtifact, changedAssets: null }],
    ["array changed map", { ...manifestArtifact, changedAssets: [] }],
    ["no artifact", {}],
  ])("rejects %s", async (_name, artifact) => {
    respond(artifact);
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        baseBundleId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    [
      "changed hash mismatch format",
      { ...changedAsset, fileHash: "sha256:" + "b".repeat(64) },
    ],
    ["missing file and patch", { fileHash: "b".repeat(64) }],
    [
      "missing explicit file field",
      { fileHash: "b".repeat(64), patch: changedAsset.patch },
    ],
    [
      "missing explicit patch field",
      { fileHash: "b".repeat(64), file: changedAsset.file },
    ],
    [
      "unsupported file compression",
      { ...changedAsset, file: { ...changedAsset.file, compression: "gzip" } },
    ],
    [
      "missing explicit file compression",
      { ...changedAsset, file: { url: changedAsset.file.url } },
    ],
    [
      "local file URL",
      {
        ...changedAsset,
        file: { url: "file:///etc/passwd", compression: null },
      },
    ],
    [
      "unsupported patch algorithm",
      {
        ...changedAsset,
        patch: { ...changedAsset.patch, algorithm: "hpatch" },
      },
    ],
    [
      "invalid base identity",
      {
        ...changedAsset,
        patch: { ...changedAsset.patch, baseBundleId: "other" },
      },
    ],
    [
      "missing base hash",
      { ...changedAsset, patch: { ...changedAsset.patch, baseFileHash: null } },
    ],
    [
      "signed patch hash",
      {
        ...changedAsset,
        patch: { ...changedAsset.patch, patchFileHash: archiveSignature },
      },
    ],
    [
      "unsafe patch URL",
      {
        ...changedAsset,
        patch: { ...changedAsset.patch, patchUrl: "//objects.test/patch" },
      },
    ],
  ])(
    "rejects %s before trusting the archive fallback",
    async (_name, asset) => {
      respond({
        ...manifestArtifact,
        fileUrl: "/storage/archive.zip",
        fileHash: archiveSignature,
        changedAssets: { "native/entry.bin": asset },
      });
      await expect(
        createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
          "target",
          baseBundleId,
        ),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );

  it.each([
    "../entry.bin",
    "/entry.bin",
    "native//entry.bin",
    "native\\entry.bin",
    "native/./entry.bin",
    "native/entry\u0000.bin",
    "manifest.json",
  ])("rejects noncanonical changed asset path %j", async (assetPath) => {
    respond({
      ...manifestArtifact,
      changedAssets: { [assetPath]: changedAsset },
    });
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        baseBundleId,
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
      vi.fn(async () => new Response("x".repeat(maxResponseBytes + 1))),
    );
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Update response exceeds the size limit.",
    });
  });

  it("rejects an oversized Content-Length before reading and cancels the body", async () => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: {
            get: () => String(maxResponseBytes + 1),
          },
          body: { cancel, getReader },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Update response exceeds the size limit.",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("cancels a chunked body that exceeds its small declared Content-Length", async () => {
    const chunks = [new Uint8Array(maxResponseBytes), new Uint8Array(1)];
    const read = vi.fn(async () => {
      const value = chunks.shift();
      return value === undefined
        ? ({ done: true, value: undefined } as const)
        : ({ done: false, value } as const);
    });
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => "1" },
          body: {
            getReader: () => ({ read, cancel, releaseLock }),
          },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Update response exceeds the size limit.",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("fails closed without streaming when Content-Length is absent", async () => {
    const text = vi.fn(async () => JSON.stringify(catalog));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: null,
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message:
        "A bounded Content-Length header is required without response streaming.",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("supports a bounded Content-Length fallback without response streams", async () => {
    const body = JSON.stringify(catalog);
    const text = vi.fn(async () => body);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => String(body.length) },
          body: null,
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).resolves.toEqual(catalog);
    expect(text).toHaveBeenCalledOnce();
  });

  it("checks actual UTF-8 bytes after the bounded non-streaming fallback", async () => {
    const text = vi.fn(async () => "가".repeat(maxResponseBytes));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => "1" },
          body: null,
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Update response exceeds the size limit.",
    });
    expect(text).toHaveBeenCalledOnce();
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
