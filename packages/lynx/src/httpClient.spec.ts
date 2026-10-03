import {
  MAX_COMPILED_CATALOG_BYTES,
  MAX_UPDATE_ARTIFACT_RESPONSE_BYTES,
} from "@hot-updater/protocol";
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
  artifactProtocolVersion: 1,
  manifestUrl: "/storage/manifest.json",
  manifestFileHash: manifestSignature,
  assets: { "native/entry.bin": changedAsset },
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
    artifactProtocolVersion: 1,
    archiveUrl: "/storage/bundle.tar.br",
    manifestUrl: "/storage/manifest.json",
    manifestFileHash: manifestSignature,
    assets: {
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
  artifact.assets["native/entry.bin"].file.url += "x".repeat(paddingLength);
  const body = JSON.stringify(artifact);
  if (body.length !== byteLength) throw new Error("Invalid artifact fixture.");
  return body;
}

describe("Lynx delivery HTTP contract", () => {
  it("uses the encoded catalog route without the deprecated Lynx request extension", async () => {
    const fetch = respond(catalog);
    const client = createHttpClient({
      baseURL: "https://updates.test/api/",
      requestHeaders: { Authorization: "test-header" },
    });
    await expect(client.fetchCatalog(state)).resolves.toEqual(catalog);
    expect(fetch).toHaveBeenCalledWith(
      "https://updates.test/api/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.2.3%2B4",
      expect.objectContaining({
        headers: { Authorization: "test-header" },
      }),
    );
    const request = (
      fetch.mock.calls as unknown as [string, RequestInit][]
    )[0]![1];
    expect(request).not.toHaveProperty("lynxExtension");
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
      "/storage/bundle.tar.br",
      "https://updates.test/api/storage/bundle.tar.br",
    ],
    [
      "https://objects.test/bundle?signature=value",
      "https://objects.test/bundle?signature=value",
    ],
  ])(
    "resolves the optional archive URL %s without changing manifest authority",
    async (archiveUrl, expected) => {
      const fetch = respond({ ...manifestArtifact, archiveUrl });
      const result = await createHttpClient({
        baseURL: "https://updates.test/api",
      }).resolveArtifact("target", baseBundleId);
      expect(result.archiveUrl).toBe(expected);
      expect(result.manifestFileHash).toBe(manifestSignature);
      expect(result.assets["native/entry.bin"].patch?.baseBundleId).toBe(
        baseBundleId,
      );
      expect(fetch).toHaveBeenCalledWith(
        `https://updates.test/api/artifacts/v1/target/from/${baseBundleId}`,
        expect.anything(),
      );
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

    expect(result).not.toHaveProperty("fileUrl");
    expect(result.manifestUrl).toBe(
      "https://updates.test/storage/manifest.json",
    );
    expect(result.assets?.["native/entry.bin"]?.file?.url).toMatch(
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
  ])("rejects an unsupported artifact URL %s", async (archiveUrl) => {
    respond({ ...manifestArtifact, archiveUrl });
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        "running",
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects the removed archive-only response", async () => {
    respond({
      fileUrl: "https://objects.test/archive",
      fileHash: "a".repeat(64),
    });
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        baseBundleId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([false, true])(
    "preserves the optional archive with the complete manifest inventory (archive=%s)",
    async (withArchive) => {
      respond({
        ...manifestArtifact,
        ...(withArchive ? { archiveUrl: "/storage/bundle.tar.br" } : {}),
      });
      // Background scripting does not require a browser URL implementation.
      vi.stubGlobal("URL", undefined);
      await expect(
        createHttpClient({
          baseURL: "https://updates.test/api",
        }).resolveArtifact("target", baseBundleId),
      ).resolves.toEqual({
        bundleId: "target",
        artifactProtocolVersion: 1,
        ...(withArchive
          ? { archiveUrl: "https://updates.test/api/storage/bundle.tar.br" }
          : {}),
        manifestUrl: "https://updates.test/api/storage/manifest.json",
        manifestFileHash: manifestSignature,
        assets: {
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

  it("requires an original file even when a patch is provided", async () => {
    respond({
      ...manifestArtifact,
      assets: { "native/entry.bin": { ...changedAsset, file: null } },
    });
    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).resolveArtifact(
        "target",
        baseBundleId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    {
      "native/entry.bin": {
        fileHash: changedAsset.fileHash,
        file: changedAsset.file,
      },
    },
    {
      "native/entry.bin": {
        ...changedAsset,
        file: { url: "/storage/raw-entry" },
        patch: undefined,
      },
    },
    {
      "assets/empty.txt": {
        fileHash: "d".repeat(64),
        file: { url: "/storage/empty.txt", compression: null },
        patch: null,
      },
    },
  ])(
    "accepts manifest updates with reusable or independently downloadable assets: %j",
    async (assets) => {
      respond({ ...manifestArtifact, assets });
      const result = await createHttpClient({
        baseURL: "https://updates.test",
      }).resolveArtifact("target", baseBundleId);
      expect(Object.keys(result.assets!)).toEqual(Object.keys(assets));
      expect(result).not.toHaveProperty("fileUrl");
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
    ["missing changed map", { ...manifestArtifact, assets: null }],
    ["array changed map", { ...manifestArtifact, assets: [] }],
    ["no artifact", {}],
    ["empty target map", { ...manifestArtifact, assets: {} }],
    [
      "missing protocol version",
      { ...manifestArtifact, artifactProtocolVersion: undefined },
    ],
    [
      "unsupported protocol version",
      { ...manifestArtifact, artifactProtocolVersion: 2 },
    ],
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
      "unsupported file compression",
      { ...changedAsset, file: { ...changedAsset.file, compression: "gzip" } },
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
        archiveUrl: "/storage/bundle.tar.br",
        assets: { "native/entry.bin": asset },
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
      assets: { [assetPath]: changedAsset },
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

  it("cancels a Lynx response body before returning an HTTP error", async () => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 503,
          headers: { get: () => null },
          body: { cancel, getReader },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "HTTP_ERROR",
      message: "Update request returned HTTP 503.",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each(["invalid", "01", "1, 1", "9007199254740992"])(
    "cancels a Lynx response body for Content-Length %j",
    async (contentLength) => {
      const cancel = vi.fn(async () => undefined);
      const getReader = vi.fn();
      const text = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Promise.resolve({
            status: 200,
            headers: { get: () => contentLength },
            body: { cancel, getReader },
            text,
          } as unknown as Response),
        ),
      );

      await expect(
        createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(
          state,
        ),
      ).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        message: "Invalid Content-Length response header.",
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(getReader).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "duplicate",
      [
        ["content-length", "1"],
        ["content-length", "1"],
      ],
    ],
    [
      "conflicting case-variant",
      [
        ["Content-Length", "1"],
        ["content-LENGTH", "2"],
      ],
    ],
  ])("rejects %s Content-Length entries", async (_name, entries) => {
    const cancel = vi.fn(async () => undefined);
    const getReader = vi.fn();
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: {
            forEach: (callback: (value: string, name: string) => void) => {
              for (const [name, value] of entries) callback(value, name);
            },
            get: vi.fn(),
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
      message: "Invalid Content-Length response header.",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
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

  it("cancels an oversized Lynx stream without TextDecoder or Content-Length", async () => {
    vi.stubGlobal("TextDecoder", undefined);
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
          headers: { get: () => null },
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

  it("decodes split UTF-8 from Lynx ArrayBuffer chunks without TextDecoder", async () => {
    const streamedCatalog = { ...catalog, catalogId: "가" };
    const bytes = new TextEncoder().encode(JSON.stringify(streamedCatalog));
    const multibyteStart = bytes.indexOf(0xea);
    expect(multibyteStart).toBeGreaterThanOrEqual(0);
    const chunks = [
      bytes.slice(0, multibyteStart + 1).buffer,
      bytes.slice(multibyteStart + 1).buffer,
    ];
    const read = vi.fn(async () => {
      const value = chunks.shift();
      return value === undefined
        ? ({ done: true, value: undefined } as const)
        : ({ done: false, value } as const);
    });
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn();
    void Response;
    vi.stubGlobal("TextDecoder", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => ({ read, cancel }) },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).resolves.toEqual(streamedCatalog);
    expect(cancel).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("honors byte offsets in Lynx ArrayBufferView chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(catalog));
    const padded = new Uint8Array(bytes.length + 2);
    padded[0] = 0xff;
    padded.set(bytes, 1);
    padded[padded.length - 1] = 0xff;
    const chunks: ArrayBufferView[] = [
      new DataView(padded.buffer, 1, bytes.length),
    ];
    const read = vi.fn(async () => {
      const value = chunks.shift();
      return value === undefined
        ? ({ done: true, value: undefined } as const)
        : ({ done: false, value } as const);
    });
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => ({ read, cancel }) },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).resolves.toEqual(catalog);
    expect(cancel).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("cancels a Lynx reader when read rejects", async () => {
    const readError = new Error("native read failed");
    const read = vi.fn(async () => Promise.reject(readError));
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => ({ read, cancel }) },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toBe(readError);
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("cancels a stalled Lynx stream when the request deadline expires", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<never>(() => undefined));
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          body: { getReader: () => ({ read, cancel }) },
          text: vi.fn(),
        } as unknown as Response),
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
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
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
      message: "A bounded response stream is required.",
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("fails closed without streaming even with bounded Content-Length", async () => {
    const body = JSON.stringify(catalog);
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn(async () => body);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => String(body.length) },
          body: { cancel },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "A bounded response stream is required.",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("finds Content-Length in a case-sensitive Headers polyfill", async () => {
    const body = JSON.stringify(catalog);
    const chunks = [new TextEncoder().encode(body)];
    const read = vi.fn(async () => {
      const value = chunks.shift();
      return value === undefined
        ? ({ done: true, value: undefined } as const)
        : ({ done: false, value } as const);
    });
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: {
            get: (name: string) =>
              name === "Content-Length" ? String(body.length) : null,
          },
          body: { getReader: () => ({ read, cancel }) },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).resolves.toEqual(catalog);
    expect(cancel).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("accepts one Content-Length from compliant Headers", async () => {
    const body = JSON.stringify(catalog);
    const chunks = [new TextEncoder().encode(body)];
    const read = vi.fn(async () => {
      const value = chunks.shift();
      return value === undefined
        ? ({ done: true, value: undefined } as const)
        : ({ done: false, value } as const);
    });
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          status: 200,
          headers: new Headers({ "Content-Length": String(body.length) }),
          body: { getReader: () => ({ read, cancel }) },
          text,
        } as unknown as Response),
      ),
    );

    await expect(
      createHttpClient({ baseURL: "https://updates.test" }).fetchCatalog(state),
    ).resolves.toEqual(catalog);
    expect(cancel).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
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
