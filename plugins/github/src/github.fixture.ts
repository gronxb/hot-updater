import { createHash } from "node:crypto";

import { createStorageUri } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  createAdminApiTestClient,
  createBundleRowFixture,
  createHandlerHttpTestClient,
  toDeployBundle,
} from "@hot-updater/test-utils";

import type { GithubRepositoryOptions } from "./githubApi";
import {
  githubJsonDatabase,
  migrateGithubJsonDatabase,
} from "./githubJsonDatabase";
import { githubReleaseStorage } from "./githubReleaseStorage";

export const FAKE_GITHUB = {
  owner: "acme",
  repo: "updates",
  token: "test-token",
} as const;

interface FakeAsset {
  readonly release: number;
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
}

const API = `https://api.github.com/repos/${FAKE_GITHUB.owner}/${FAKE_GITHUB.repo}`;
const UPLOADS = `https://uploads.github.com/repos/${FAKE_GITHUB.owner}/${FAKE_GITHUB.repo}`;
const DOWNLOADS = "https://release-assets.githubusercontent.test";

const gitBlobSha = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The parts of GitHub the adapters call, in memory: a repository's contents
 * with the `sha` compare-and-swap of a write, releases, and release assets
 * behind the redirect to a signed URL. It refuses what GitHub refuses: a
 * request without the token, an empty asset, a duplicate asset name, and a
 * write whose `sha` is stale or missing.
 */
export const createFakeGithub = () => {
  const files = new Map<string, string>();
  const releases = new Set<number>();
  const assets = new Map<number, FakeAsset>();
  let nextId = 1;
  let commits = 0;

  const contents = (path: string, method: string, init: RequestInit) => {
    const current = files.get(path);
    if (method === "GET") {
      if (current === undefined) return json(404, { message: "Not Found" });
      const etag = `"${gitBlobSha(current)}"`;
      const headers = init.headers as Record<string, string>;
      return headers["if-none-match"] === etag
        ? new Response(null, { status: 304, headers: { etag } })
        : new Response(current, { status: 200, headers: { etag } });
    }
    const body = JSON.parse(init.body as string) as {
      content: string;
      sha?: string;
    };
    if (current !== undefined && body.sha === undefined) {
      return json(422, { message: '"sha" wasn\'t supplied.' });
    }
    if (
      body.sha !== (current === undefined ? undefined : gitBlobSha(current))
    ) {
      return json(409, { message: `${path} does not match ${body.sha}` });
    }
    const text = Buffer.from(body.content, "base64").toString("utf8");
    files.set(path, text);
    commits += 1;
    return json(current === undefined ? 201 : 200, {
      content: { sha: gitBlobSha(text) },
    });
  };

  const fetch = (async (input, init = {}) => {
    const url = new URL(String(input));
    const href = `${url.origin}${url.pathname}`;
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;

    if (href.startsWith(`${DOWNLOADS}/`)) {
      const asset = assets.get(Number(url.pathname.slice(1)));
      return asset === undefined || url.searchParams.get("sig") === null
        ? new Response(null, { status: 404 })
        : new Response(asset.bytes.slice(), {
            headers: { "content-type": "application/octet-stream" },
          });
    }
    if (headers.authorization !== `Bearer ${FAKE_GITHUB.token}`) {
      return json(401, { message: "Bad credentials" });
    }

    if (href.startsWith(`${UPLOADS}/releases/`)) {
      const release = Number(url.pathname.split("/").at(-2));
      const name = url.searchParams.get("name")!;
      const bytes = new Uint8Array(init.body as Uint8Array<ArrayBuffer>);
      const siblings = [...assets.values()].filter(
        (asset) => asset.release === release,
      );
      if (
        !releases.has(release) ||
        bytes.byteLength === 0 ||
        siblings.length >= 1000 ||
        siblings.some((asset) => asset.name === name)
      ) {
        return json(422, { message: "Validation Failed" });
      }
      const id = nextId++;
      assets.set(id, {
        release,
        name,
        bytes,
        contentType: headers["content-type"]!,
      });
      return json(201, { id });
    }

    const path = href.slice(API.length);
    if (path.startsWith("/contents/")) {
      return contents(
        decodeURIComponent(path.slice("/contents/".length)),
        method,
        init,
      );
    }
    if (path === "/releases" && method === "POST") {
      const id = nextId++;
      releases.add(id);
      return json(201, { id });
    }
    const asset = /^\/releases\/assets\/(\d+)$/u.exec(path);
    if (asset !== null) {
      const id = Number(asset[1]);
      if (!assets.has(id)) return json(404, { message: "Not Found" });
      if (method === "DELETE") {
        assets.delete(id);
        return new Response(null, { status: 204 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: `${DOWNLOADS}/${id}?sig=${nextId++}` },
      });
    }
    return json(404, { message: "Not Found" });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    /** How many commits the repository has taken. */
    commits: () => commits,
    assets: () => assets.size,
    /** A file's parsed JSON, or undefined when it does not exist. */
    readJson: (path: string): { revision: number; data: unknown } | undefined =>
      files.has(path) ? JSON.parse(files.get(path)!) : undefined,
    /** Replaces a file, as another process's commit would. */
    writeJson: (path: string, value: unknown) => {
      files.set(path, JSON.stringify(value));
    },
  };
};

export const FIXTURE_BUNDLE_HASH = "a".repeat(64);
export const FIXTURE_BUNDLE_BYTES = new TextEncoder().encode(
  "compressed hermes bundle",
);

/**
 * What `hot-updater deploy` leaves in a repository: the database file, a
 * bundle's manifest and its one file in storage, and a release of it on the
 * `production` channel for every iOS app version.
 */
export const deployFixtureBundle = async (
  config: GithubRepositoryOptions & {
    readonly path?: string;
    readonly indexPath?: string;
    readonly basePath?: string;
  },
) => {
  const bundle = createBundleRowFixture("901");
  const manifest = JSON.stringify({
    bundleId: bundle.id,
    assets: {
      "index.ios.bundle": {
        fileHash: "hbc-hash",
        downloadFileHash: FIXTURE_BUNDLE_HASH,
        downloadByteSize: FIXTURE_BUNDLE_BYTES.byteLength,
      },
    },
  });
  const stream = (bytes: Uint8Array<ArrayBuffer>) => new Response(bytes).body!;

  await migrateGithubJsonDatabase(config);
  const storage = githubReleaseStorage(config);
  const { storageUri } = await storage.put({
    key: `bundles/${bundle.id}/manifest.json`,
    body: stream(new TextEncoder().encode(manifest)),
    contentType: "application/json",
  });
  const asset = await storage.put({
    key: `assets/sha256/aa/${FIXTURE_BUNDLE_HASH}.br`,
    body: stream(FIXTURE_BUNDLE_BYTES),
    contentType: "application/octet-stream",
  });
  const server = createHotUpdater({
    database: githubJsonDatabase(config),
    storage,
    clientAccess: "public",
  });
  const admin = createAdminApiTestClient(() =>
    createHandlerHttpTestClient(server.handlers),
  );
  await admin.deploy({
    bundle: toDeployBundle({
      ...bundle,
      manifest_storage_uri: storageUri,
      asset_base_storage_uri: createStorageUri({
        protocol: "github-release",
        bucket: `${config.owner}.${config.repo}`,
        key: [config.basePath, "assets"].filter(Boolean).join("/"),
      }),
    }),
    release: {
      channel: "production",
      enabled: true,
      fingerprintHash: null,
      message: "first",
      shouldForceUpdate: false,
      targetAppVersion: "*",
    },
  });
  return { bundle, manifest, storage, assetUri: asset.storageUri };
};
