import { canonicalizeAppVersion } from "@hot-updater/plugin-core";
import { createReleaseCatalogScopeKey } from "@hot-updater/protocol";
import { createHotUpdater } from "@hot-updater/server";

import type { GithubRepositoryOptions } from "./githubApi";
import { githubJsonDatabase } from "./githubJsonDatabase";
import { githubReleaseStorage } from "./githubReleaseStorage";

/**
 * The `baseURL` of an app that has no update server. `.invalid` never
 * resolves, so a request `githubUpdateFetch` does not answer, such as the
 * native check after a crash, fails at once instead of reaching a host.
 */
export const GITHUB_UPDATE_BASE_URL = "https://github.hot-updater.invalid";

export interface GithubUpdateFetchConfig extends GithubRepositoryOptions {
  /** The `baseURL` passed to `HotUpdater.init`. Defaults to `GITHUB_UPDATE_BASE_URL`. */
  readonly baseURL?: string;
  /** As `githubJsonDatabase`'s `path`. */
  readonly databasePath?: string;
  /** As `githubReleaseStorage`'s `indexPath`. */
  readonly storageIndexPath?: string;
  /** As `githubReleaseStorage`'s `basePath`. */
  readonly basePath?: string;
  /** The branch that holds both files. */
  readonly branch?: string;
  /**
   * How long an update check may answer from the files the app last
   * fetched, in milliseconds. Defaults to 5,000, the time an update server
   * keeps a catalog.
   */
  readonly cacheTtlMs?: number;
}

const CATALOG_CONTENT_TYPE =
  "application/vnd.hot-updater.release-catalog+json; version=1";
const ARTIFACT_CONTENT_TYPE =
  "application/vnd.hot-updater.artifact+json; version=1";

const json = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const notFound = () => json({ error: "Not found" }, 404);

/** Rejects as `fetch` does when `signal` aborts before `work` settles. */
const abortable = <T>(work: Promise<T>, signal?: AbortSignal | null) => {
  if (signal == null) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
};

/**
 * A `fetch` for `HotUpdater.init` that answers the update protocol inside
 * the app, from a GitHub repository, so the app needs no update server. It
 * reads the database file and the storage index with the token, and hands
 * native the signed URLs GitHub issues for the release assets.
 *
 * It answers update checks and artifact protocol v1, whose response carries
 * every file's URL; protocol v2 asks the server for file URLs from native
 * code, which no in-app `fetch` can answer. Requests to any other URL go to
 * the underlying `fetch`.
 *
 * The token ships in the app, so anyone who has the app can read it: give
 * it read access to this repository's contents and nothing else.
 */
export const githubUpdateFetch = (
  config: GithubUpdateFetchConfig,
): typeof fetch => {
  const baseURL = (config.baseURL ?? GITHUB_UPDATE_BASE_URL).replace(
    /\/+$/u,
    "",
  );
  const cacheTtlMs = config.cacheTtlMs ?? 5_000;
  const { core } = createHotUpdater({
    database: githubJsonDatabase({
      ...config,
      path: config.databasePath,
      cacheTtlMs,
    }),
    storage: githubReleaseStorage({
      ...config,
      indexPath: config.storageIndexPath,
      cacheTtlMs,
    }),
    clientAccess: "public",
  });

  const catalog = async (
    strategy: string,
    platform: string,
    channelKey: string,
    value: string,
  ): Promise<Response> => {
    if (platform !== "ios" && platform !== "android") {
      return json({ error: `Invalid platform: ${platform}` }, 400);
    }
    const input =
      strategy === "app-version"
        ? ({
            strategy: "APP_VERSION",
            platform,
            channelKey,
            appVersion: value,
          } as const)
        : ({
            strategy: "FINGERPRINT",
            platform,
            channelKey,
            fingerprintHash: value,
          } as const);
    if (
      input.strategy === "APP_VERSION" &&
      canonicalizeAppVersion(value) !== value
    ) {
      return json({ error: "Invalid app version" }, 400);
    }
    try {
      createReleaseCatalogScopeKey(input);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Invalid scope" },
        400,
      );
    }
    const found = await core.getReleaseCatalog(input);
    return found === null
      ? json({ error: "Not found" }, 404, { "x-hot-updater-catalog": "none" })
      : json(found, 200, { "content-type": CATALOG_CONTENT_TYPE });
  };

  const answer = async (method: string, path: string): Promise<Response> => {
    if (method !== "GET") return notFound();
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    const [area, kind, first, second, third] = segments;
    if (
      area === "release-catalogs" &&
      (kind === "app-version" || kind === "fingerprint") &&
      segments.length === 5
    ) {
      return catalog(kind, first!, second!, third!);
    }
    if (
      area === "artifacts" &&
      kind === "v1" &&
      second === "from" &&
      segments.length === 5
    ) {
      const info = await core.getArtifactInfo(first!, third!, 1);
      return info === null
        ? notFound()
        : json(info, 200, { "content-type": ARTIFACT_CONTENT_TYPE });
    }
    return notFound();
  };

  return (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== baseURL && !url.startsWith(`${baseURL}/`)) {
      return (config.fetch ?? fetch)(input, init);
    }
    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET")
    ).toUpperCase();
    const path = url.slice(baseURL.length).split(/[?#]/u, 1)[0]!;
    return abortable(answer(method, path), init?.signal);
  };
};
