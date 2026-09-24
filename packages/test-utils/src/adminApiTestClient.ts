import type { Bundle } from "@hot-updater/core";
import type {
  BundleRow,
  ChannelRow,
  DeployReleasePolicy,
  ReleaseCatalogMutationResult,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { expect } from "vitest";

import type { HttpTestClient, HttpTestRequestInit } from "./httpTestClient";

export const jsonRequest = (
  method: string,
  body?: unknown,
): HttpTestRequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** A bundle row as the deploy route takes it. */
export const toDeployBundle = (row: BundleRow): Bundle => ({
  id: row.id,
  platform: row.platform,
  gitCommitHash: row.git_commit_hash,
  manifestStorageUri: row.manifest_storage_uri,
  manifestFileHash: row.manifest_file_hash,
  assetBaseStorageUri: row.asset_base_storage_uri,
  ...(row.metadata === null ? {} : { metadata: row.metadata as never }),
});

/**
 * Admin API protocol 2 over a test client. Each JSON call checks the answer
 * is private and names the request when it fails. `track` records what a
 * test wrote, and `cleanup` deletes it again: its releases, then its
 * bundles, newest first.
 */
export const createAdminApiTestClient = (getClient: () => HttpTestClient) => {
  const admin = (path: string, init?: HttpTestRequestInit) =>
    getClient().admin(path, init);
  const adminJson = async (path: string, init?: HttpTestRequestInit) => {
    const response = await admin(path, init);
    const text = await response.text();
    expect(response.ok, `${init?.method ?? "GET"} ${path}: ${text}`).toBe(true);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return text === "" ? undefined : JSON.parse(text);
  };

  const releases: string[] = [];
  const bundles: string[] = [];

  /** One deployment through `POST /releases`: a new bundle, or a stored one's id. */
  const deploy = async (
    deployment:
      | { readonly bundle: Bundle; readonly release: DeployReleasePolicy }
      | { readonly bundleId: string; readonly release: DeployReleasePolicy },
  ): Promise<ReleaseRow> => {
    const { data } = (await adminJson(
      "/releases",
      jsonRequest("POST", { deployments: [deployment] }),
    )) as { data: ReleaseCatalogMutationResult[] };
    const release = data[0]?.release;
    if (!release) throw new Error("The deploy answered no release.");
    releases.push(release.id);
    if ("bundle" in deployment) bundles.push(deployment.bundle.id);
    return release;
  };

  const ensureChannel = async (name: string): Promise<ChannelRow> =>
    (
      (await adminJson("/channels", jsonRequest("POST", { name }))) as {
        data: ChannelRow;
      }
    ).data;

  /** Hard-deletes a release: disabled first, as the route requires. */
  const removeRelease = async (id: string) => {
    const current = await admin(`/releases/${encodeURIComponent(id)}`);
    if (current.status === 404) {
      await current.text();
      return;
    }
    const { data: row } = (await current.json()) as { data: ReleaseRow };
    if (row.enabled) {
      await adminJson(
        `/releases/${encodeURIComponent(id)}`,
        jsonRequest("PATCH", { patch: { enabled: false } }),
      );
    }
    await adminJson(
      `/releases/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`,
      jsonRequest("DELETE"),
    );
  };

  const cleanup = async () => {
    for (const id of releases.splice(0).reverse()) await removeRelease(id);
    for (const id of bundles.splice(0).reverse()) {
      await adminJson("/bundles/delete", jsonRequest("POST", { ids: [id] }));
    }
  };

  return {
    admin,
    adminJson,
    deploy,
    ensureChannel,
    removeRelease,
    /** Tracks a release the server wrote for a test, such as a promotion's copy. */
    track: (releaseId: string) => {
      releases.push(releaseId);
    },
    /** Stops tracking a release a test already deleted. */
    forget: (releaseId: string) => {
      const index = releases.indexOf(releaseId);
      if (index >= 0) releases.splice(index, 1);
    },
    cleanup,
  };
};

export type AdminApiTestClient = ReturnType<typeof createAdminApiTestClient>;
