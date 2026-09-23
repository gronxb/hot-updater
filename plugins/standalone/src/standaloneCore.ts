import {
  DatabaseBundleNotFoundError,
  ReleaseCatalogMutationError,
  ReleaseManagementError,
} from "@hot-updater/plugin-core";
import type {
  BundleDetail,
  BundlePatchRow,
  ChannelDeleteResult,
  ChannelRow,
  HotUpdaterCoreApi,
  KeysetInput,
  PromoteReleaseResult,
  ReleaseCatalogMutationPreflight,
  ReleaseCatalogMutationResult,
  ReleaseCatalogRebuildPreflight,
  ReleaseCatalogRebuildResult,
  ReleaseCatalogRow,
  ReleaseFilter,
  ReleaseRow,
} from "@hot-updater/plugin-core";

import {
  createStandaloneHttp,
  StandaloneDatabaseError,
} from "./standaloneHttp";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

/** The admin API protocol this client speaks; the server's `/version` must report it or a later one. */
export const STANDALONE_ADMIN_PROTOCOL = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ManagementCode = ReleaseManagementError["code"];
type CatalogCode = ReleaseCatalogMutationError["code"];

const MANAGEMENT_CODES = new Set<string>([
  "ENABLED_RELEASE",
  "RELEASE_NOT_FOUND",
  "SCOPE_MOVE_UNSUPPORTED",
  "TARGET_RELEASE_INVALID",
  "VERSION_CONFLICT",
] satisfies ManagementCode[]);
const CATALOG_CODES = new Set<string>([
  "CATALOG_GENERATION_EXHAUSTED",
  "CATALOG_IDENTITY_MISSING",
  "INVALID_SCOPE",
  "NON_MONOTONIC_RELEASE_ID",
] satisfies CatalogCode[]);

/** A refusal the server named, as the error core throws in process; anything else as a request failure. */
const refusal = (status: number, value: unknown, fallback: string): Error => {
  const code = isRecord(value) ? value.code : undefined;
  const message =
    isRecord(value) && typeof value.error === "string" ? value.error : fallback;
  if (typeof code === "string" && MANAGEMENT_CODES.has(code)) {
    return new ReleaseManagementError(code as ManagementCode, message);
  }
  if (typeof code === "string" && CATALOG_CODES.has(code)) {
    return new ReleaseCatalogMutationError(code as CatalogCode, message);
  }
  if (code === "BUNDLE_NOT_FOUND" && isRecord(value)) {
    const id = /"([^"]+)"/u.exec(message)?.[1] ?? "";
    return new DatabaseBundleNotFoundError(id);
  }
  return new StandaloneDatabaseError("request-failed", message, status);
};

const keysetParams = ({ order, after, limit }: KeysetInput) => ({
  v: String(STANDALONE_ADMIN_PROTOCOL),
  limit: String(limit),
  ...(order === undefined ? {} : { order }),
  ...(after === undefined ? {} : { cursor: after }),
});

const filterParams = (filter: ReleaseFilter): Record<string, string> => {
  switch (filter.kind) {
    case "all":
      return {};
    case "bundle":
      return { bundleId: filter.bundleId };
    case "scope":
      return {
        scopeKey: filter.scopeKey,
        ...(filter.enabled === undefined
          ? {}
          : { enabled: String(filter.enabled) }),
      };
    case "channelPlatform":
      return {
        channelId: filter.channelId,
        platform: filter.platform,
        ...(filter.enabled === undefined
          ? {}
          : { enabled: String(filter.enabled) }),
      };
  }
};

/**
 * Core's API over a self-hosted server's admin handler, protocol 2: the CLI's
 * path to a database it cannot open itself. The first call checks that the
 * server speaks protocol 2, so an older server fails fast.
 */
export const createStandaloneCoreApi = (
  config: StandaloneRepositoryConfig,
): HotUpdaterCoreApi => {
  const http = createStandaloneHttp(config);
  let checked: Promise<void> | undefined;

  const checkProtocol = async () => {
    const response = await fetch(http.buildUrl("/version"), {
      headers: http.headers({ "Cache-Control": "no-cache" }),
    });
    const body: unknown =
      response.status === 404 ? {} : await http.parseJson(response);
    const protocol = isRecord(body) ? body.adminProtocol : undefined;
    if (typeof protocol !== "number" || protocol < STANDALONE_ADMIN_PROTOCOL) {
      throw new StandaloneDatabaseError(
        "request-failed",
        `The server at ${config.baseUrl} speaks admin API protocol ${typeof protocol === "number" ? protocol : 1}, and this CLI needs ${STANDALONE_ADMIN_PROTOCOL}. Upgrade @hot-updater/server on the server.`,
        response.status,
      );
    }
  };

  /** One admin request's JSON body, or null for 204 and for a GET that finds nothing; `/version` is checked once before the first. */
  const request = async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    {
      query = {},
      body,
    }: {
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    } = {},
  ): Promise<Record<string, unknown> | null> => {
    checked ??= checkProtocol().catch((error: unknown) => {
      checked = undefined;
      throw error;
    });
    await checked;
    const url = new URL(http.buildUrl(path));
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      headers: http.headers(
        method === "GET" ? { "Cache-Control": "no-cache" } : undefined,
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return null;
    if (method === "GET" && response.status === 404) return null;
    if (response.status === 503) {
      // The server's schema fence answers 503 until its database is migrated.
      throw new StandaloneDatabaseError(
        "request-failed",
        `The server at ${config.baseUrl} answered ${method} ${path} with 503: its database is not ready. If it needs migrations, run \`hot-updater db migrate\` where the server's database is configured.`,
        503,
      );
    }
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      throw refusal(
        response.status,
        failure,
        `${method} ${path} failed with status ${response.status}.`,
      );
    }
    const value = await http.parseJson(response);
    if (!isRecord(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        `The server answered ${method} ${path} with no JSON object.`,
        response.status,
      );
    }
    return value;
  };

  /** A request's `data`, or null when it found nothing. */
  const call = async <T>(
    ...args: Parameters<typeof request>
  ): Promise<T | null> => {
    const value = await request(...args);
    if (value === null) return null;
    if (!("data" in value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        `The server answered ${args[0]} ${args[1]} without data.`,
      );
    }
    return value.data as T;
  };

  const list = async <T>(
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<T[]> => (await call<T[]>("GET", path, { query })) ?? [];

  const v2 = { v: String(STANDALONE_ADMIN_PROTOCOL) };
  const encode = encodeURIComponent;

  return {
    ready: async () => {
      await list("/release-catalogs", { ...v2, limit: "1" });
    },
    getBundle: (id) =>
      call<BundleDetail>("GET", `/bundles/${encode(id)}`, { query: v2 }),
    listBundles: ({ platform, ...input }) =>
      list<BundleDetail>("/bundles", {
        ...keysetParams(input),
        ...(platform === undefined ? {} : { platform }),
      }),
    countBundles: async (platform) => {
      const value = await request("GET", "/bundles", {
        query: {
          ...v2,
          limit: "1",
          total: "true",
          ...(platform === undefined ? {} : { platform }),
        },
      });
      if (value === null || typeof value.total !== "number") {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "The server answered a bundle count without total.",
        );
      }
      return value.total;
    },
    listPatchesFromBase: (baseBundleId, input) =>
      list<BundlePatchRow>(
        `/bundles/${encode(baseBundleId)}/children`,
        keysetParams(input),
      ),
    findBaseBundleIds: (candidateKey, bundleId, limit) =>
      list<string>(`/base-candidates/${encode(candidateKey)}`, {
        before: bundleId,
        limit: String(limit),
      }),
    getRelease: (id) => call<ReleaseRow>("GET", `/releases/${encode(id)}`),
    listReleases: ({ filter, ...input }) =>
      list<ReleaseRow>("/releases", {
        ...keysetParams(input),
        ...filterParams(filter),
      }),
    getReleaseCatalogRow: (scopeKey) =>
      call<ReleaseCatalogRow>("GET", `/release-catalogs/${encode(scopeKey)}`),
    listReleaseCatalogs: (input) =>
      list<ReleaseCatalogRow>("/release-catalogs", keysetParams(input)),
    listChannels: () => list<ChannelRow>("/channels", v2),
    findChannelByName: (name) =>
      call<ChannelRow>("GET", "/channels", { query: { ...v2, name } }),

    deploy: async (deployments) =>
      (await call<ReleaseCatalogMutationResult[]>("POST", "/releases", {
        body: { deployments },
      }))!,
    updateReleasePolicy: async ({ releaseId, ...input }) =>
      (await call<ReleaseCatalogMutationResult>(
        "PATCH",
        `/releases/${encode(releaseId)}`,
        { body: input },
      ))!,
    preflightReleasePolicy: async ({ releaseId, ...input }) =>
      (await call<ReleaseCatalogMutationPreflight>(
        "POST",
        `/releases/${encode(releaseId)}/preflight`,
        { body: input },
      ))!,
    deleteRelease: async ({ releaseId, expectedRevision }) =>
      (await call<ReleaseCatalogMutationResult>(
        "DELETE",
        `/releases/${encode(releaseId)}`,
        {
          query: {
            confirm: releaseId,
            ...(expectedRevision === undefined
              ? {}
              : { expectedRevision: String(expectedRevision) }),
          },
        },
      ))!,
    promoteRelease: async ({ releaseId, ...input }) =>
      (await call<PromoteReleaseResult>(
        "POST",
        `/releases/${encode(releaseId)}/promote`,
        { body: input },
      ))!,
    rebuildReleaseCatalog: async (scopeKey) =>
      (await call<ReleaseCatalogRebuildResult>(
        "POST",
        `/release-catalogs/${encode(scopeKey)}/rebuild`,
      ))!,
    preflightReleaseCatalogRebuild: async (scopeKey) =>
      (await call<ReleaseCatalogRebuildPreflight>(
        "POST",
        `/release-catalogs/${encode(scopeKey)}/preflight`,
      ))!,
    ensureChannel: async (name) =>
      (await call<ChannelRow>("POST", "/channels", {
        query: v2,
        body: { name },
      }))!,
    deleteChannel: async (id) => {
      const response = await call<ChannelDeleteResult>(
        "DELETE",
        `/channels/${encode(id)}`,
      ).catch((error: unknown) => {
        if (error instanceof StandaloneDatabaseError && error.status === 409) {
          return { deleted: false, reason: "not_empty" } as const;
        }
        if (error instanceof StandaloneDatabaseError && error.status === 404) {
          return { deleted: false, reason: "not_found" } as const;
        }
        throw error;
      });
      return response ?? { deleted: true };
    },
    updateBundle: async (id, update) => {
      await request("PATCH", `/bundles/${encode(id)}`, { body: update });
    },
    deleteBundles: async (ids) => {
      await request("POST", "/bundles/delete", { body: { ids } });
    },
  };
};
