import type {
  ArtifactInfo,
  ArtifactInfoV2,
  ReleaseCatalog,
} from "@hot-updater/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FetchJSONResponseError } from "./fetchJSON";
import { createHttpClient } from "./httpClient";
import { InvalidUpdateResponseError } from "./updateError";

const mocks = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  fetchJSON: vi.fn(),
}));

vi.mock("./releaseCatalogCache", () => ({
  fetchReleaseCatalogWithCache: mocks.fetchCatalog,
}));

vi.mock("./fetchJSON", () => ({
  FetchJSONResponseError: class FetchJSONResponseError extends Error {
    constructor(
      readonly status: number,
      statusText: string,
    ) {
      super(statusText);
    }
  },
  fetchJSON: mocks.fetchJSON,
}));

const artifact: ArtifactInfo = {
  artifactProtocolVersion: 1,
  assets: {
    "index.ios.bundle": {
      file: { url: "https://cdn.example.com/index.bundle.br" },
      fileHash: "bundle-hash",
    },
  },
  manifestFileHash: "manifest-hash",
  manifestUrl: "https://cdn.example.com/manifest.json",
  archiveUrl: "https://cdn.example.com/bundle.tar.br",
};

const artifactV2: ArtifactInfoV2 = {
  artifactProtocolVersion: 2,
  manifestFileHash: "manifest-hash",
  manifestUrl: "https://cdn.example.com/manifest.json",
  archiveUrl: "https://cdn.example.com/bundle.tar.br",
  patch: {
    algorithm: "bsdiff",
    assetPath: "index.ios.bundle",
    baseBundleId: "current",
    baseFileHash: "base-hash",
    patchFileHash: "patch-hash",
    patchUrl: "https://cdn.example.com/index.ios.bundle.bsdiff",
  },
};

/** A server that answers artifact protocol v2, or only v1 when `v1Only`. */
const serveArtifacts = ({
  v1 = artifact as unknown,
  v2 = artifactV2 as unknown,
  v1Only = false,
} = {}) =>
  mocks.fetchJSON.mockImplementation(async ({ url }: { url: string }) => {
    if (url.includes("/artifacts/v2/")) {
      if (v1Only) throw new FetchJSONResponseError(404, "Not Found");
      return v2;
    }
    return v1;
  });

const catalog: ReleaseCatalog = {
  catalogId: "server-owned-project",
  catalogHash: `sha256:${"a".repeat(64)}`,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 1,
  releases: [],
  rollbackReleases: [],
  schemaVersion: 1,
  scopeKey: "v1:app-version:server-owned-project:ios:cHJvZHVjdGlvbg",
};

describe("private HotUpdater HTTP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCatalog.mockResolvedValue(catalog);
    serveArtifacts();
  });

  it("fetches a catalog without putting its internal identity in the route", async () => {
    const session = await createHttpClient(
      "https://updates.example.com/hot-updater/",
    ).createSession();

    await expect(
      session.fetchReleaseCatalog({
        appVersion: "1.2.0",
        channel: "production",
        fingerprintHash: null,
        platform: "ios",
        updateStrategy: "appVersion",
      }),
    ).resolves.toBe(catalog);

    expect(mocks.fetchCatalog).toHaveBeenCalledWith({
      baseURL: "https://updates.example.com/hot-updater",
      expectedScope: {
        channelKey: "cHJvZHVjdGlvbg",
        platform: "ios",
        strategy: "APP_VERSION",
      },
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://updates.example.com/hot-updater/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.2.0",
    });
  });

  it("resolves a functional baseURL once per session and captures it for a deferred artifact", async () => {
    const resolveBaseURL = vi
      .fn()
      .mockResolvedValueOnce("https://first.example.com/hot-updater")
      .mockResolvedValueOnce("https://second.example.com/hot-updater");
    const client = createHttpClient(resolveBaseURL);
    const firstSession = await client.createSession();

    await firstSession.fetchReleaseCatalog({
      appVersion: "1.2.0",
      channel: "production",
      fingerprintHash: null,
      platform: "ios",
      updateStrategy: "appVersion",
    });
    await expect(
      firstSession.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).resolves.toEqual({
      archiveUrl: "https://cdn.example.com/bundle.tar.br",
      assets: {
        "index.ios.bundle": {
          patch: {
            algorithm: "bsdiff",
            baseBundleId: "current",
            baseFileHash: "base-hash",
            patchFileHash: "patch-hash",
            patchUrl: "https://cdn.example.com/index.ios.bundle.bsdiff",
          },
        },
      },
      filesUrl:
        "https://first.example.com/hot-updater/artifacts/v2/target/files",
      manifestFileHash: "manifest-hash",
      manifestUrl: "https://cdn.example.com/manifest.json",
    });

    expect(resolveBaseURL).toHaveBeenCalledOnce();
    expect(mocks.fetchJSON).toHaveBeenCalledOnce();
    expect(mocks.fetchJSON).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://first.example.com/hot-updater/artifacts/v2/target/from/current",
    });

    await client.createSession();
    expect(resolveBaseURL).toHaveBeenCalledTimes(2);
  });

  it("falls back to artifact protocol v1 on a server without v2", async () => {
    serveArtifacts({ v1Only: true });
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        requestHeaders: { "x-api-key": "key" },
        targetBundleId: "target",
      }),
    ).resolves.toEqual(artifact);
    expect(mocks.fetchJSON.mock.calls.map(([input]) => input.url)).toEqual([
      "https://updates.example.com/artifacts/v2/target/from/current",
      "https://updates.example.com/artifacts/v1/target/from/current",
    ]);
  });

  it("keeps any other v2 failure", async () => {
    const unauthorized = new FetchJSONResponseError(401, "Unauthorized");
    mocks.fetchJSON.mockRejectedValue(unauthorized);
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toBe(unauthorized);
    expect(mocks.fetchJSON).toHaveBeenCalledOnce();
  });

  it("rejects relative artifact URLs", async () => {
    serveArtifacts({
      v1: {
        ...artifact,
        assets: {
          "index.ios.bundle": {
            file: { url: "/storage/index.bundle.br" },
            fileHash: "bundle-hash",
          },
        },
      },
      v1Only: true,
    });
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toThrow("Artifact URLs must be absolute HTTP(S) URLs.");

    serveArtifacts({
      v2: { ...artifactV2, archiveUrl: "/storage/bundle.tar.br" },
    });
    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toThrow("Artifact URLs must be absolute HTTP(S) URLs.");
  });

  it("rejects a response in another artifact protocol", async () => {
    serveArtifacts({ v2: { artifactProtocolVersion: 3 } });
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toThrow("does not support artifact protocol 2");
  });

  it("passes the server's 404 for a missing artifact through", async () => {
    const notFound = new FetchJSONResponseError(404, "Not Found");
    mocks.fetchJSON.mockRejectedValue(notFound);
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toBe(notFound);
  });

  it.each([
    { label: "a response without the protocol fields", response: {} },
    {
      label: "an invalid absolute URL",
      response: {
        ...artifactV2,
        manifestUrl: "https://",
      },
    },
  ])("marks $label as an invalid update response", async ({ response }) => {
    serveArtifacts({ v2: response });
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toBeInstanceOf(InvalidUpdateResponseError);
  });

  it("requires a functional baseURL to resolve to a non-empty string", async () => {
    await expect(createHttpClient(() => "").createSession()).rejects.toThrow(
      "baseURL function must return a non-empty string",
    );
  });
});
