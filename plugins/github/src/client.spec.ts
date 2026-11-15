import {
  type ArtifactInfo,
  encodeChannelKey,
  type ReleaseCatalog,
  selectDesiredRelease,
} from "@hot-updater/protocol";
import { createBundleRowFixture } from "@hot-updater/test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { GITHUB_UPDATE_BASE_URL, githubUpdateFetch } from "./client";
import {
  createFakeGithub,
  deployFixtureBundle,
  FAKE_GITHUB,
  FIXTURE_BUNDLE_BYTES,
} from "./github.fixture";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe("githubUpdateFetch", () => {
  const github = createFakeGithub();
  const network = vi.fn(github.fetch);
  const config = { ...FAKE_GITHUB, fetch: network as typeof fetch };
  const bundle = createBundleRowFixture("901");
  let manifest: string;
  /** The app's side: no server, only the repository and a token. */
  const appFetch = githubUpdateFetch({ ...config, cacheTtlMs: 0 });
  const get = (path: string) => appFetch(`${GITHUB_UPDATE_BASE_URL}${path}`);
  const catalogPath = (platform: string) =>
    `/release-catalogs/app-version/${platform}/${encodeChannelKey("production")}/1.2.3`;

  // The deploy side: the CLI's storage and database over the same repository.
  beforeAll(async () => {
    ({ manifest } = await deployFixtureBundle(config));
  });

  it("answers an update check with the catalog the device selects its update from", async () => {
    const response = await get(catalogPath("ios"));

    expect(response.status).toBe(200);
    const catalog = (await response.json()) as ReleaseCatalog;
    expect(
      selectDesiredRelease(catalog, {
        builtInBundleId: NIL_UUID,
        currentBundleId: NIL_UUID,
        activeReleaseId: null,
        minimumReleaseId: NIL_UUID,
        cohort: "1",
        crashedBundleIds: [],
      }),
    ).toMatchObject({ kind: "BUNDLE", bundleId: bundle.id, status: "UPDATE" });
  });

  it("marks a scope without a catalog as no update, not as a failure", async () => {
    const response = await get(catalogPath("android"));

    expect(response.status).toBe(404);
    expect(response.headers.get("x-hot-updater-catalog")).toBe("none");
  });

  it("resolves an artifact to signed URLs that serve the files without the token", async () => {
    const response = await get(`/artifacts/v1/${bundle.id}/from/${NIL_UUID}`);

    expect(response.status).toBe(200);
    const info = (await response.json()) as ArtifactInfo;
    const download = async (url: string) => {
      const file = await github.fetch(url);
      expect(file.status).toBe(200);
      return new Uint8Array(await file.arrayBuffer());
    };
    expect(new TextDecoder().decode(await download(info.manifestUrl))).toBe(
      manifest,
    );
    expect(await download(info.assets["index.ios.bundle"]!.file.url)).toEqual(
      FIXTURE_BUNDLE_BYTES,
    );
  });

  it("answers 404 to artifact protocol v2, so the SDK falls back to v1", async () => {
    const info = await get(`/artifacts/v2/${bundle.id}/from/${NIL_UUID}`);
    const files = await appFetch(
      `${GITHUB_UPDATE_BASE_URL}/artifacts/v2/${bundle.id}/files`,
      { method: "POST", body: JSON.stringify({ paths: ["index.ios.bundle"] }) },
    );

    expect([info.status, files.status]).toEqual([404, 404]);
  });

  it("answers 404 for a bundle the repository does not hold", async () => {
    const response = await get(`/artifacts/v1/${NIL_UUID}/from/${NIL_UUID}`);

    expect(response.status).toBe(404);
  });

  it("sends every other URL to the underlying fetch", async () => {
    network.mockClear();
    await appFetch("https://insights.example.com/events", { method: "POST" });

    expect(network).toHaveBeenCalledExactlyOnceWith(
      "https://insights.example.com/events",
      { method: "POST" },
    );
  });

  it("rejects when the request's signal aborts, as fetch does", async () => {
    const reason = new Error("timed out");

    await expect(
      appFetch(`${GITHUB_UPDATE_BASE_URL}${catalogPath("ios")}`, {
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
  });
});
