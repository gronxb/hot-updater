import type {
  Bundle,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseImplementationResult,
  DatabaseModel,
  DatabasePluginImplementation,
  PaginatedResult,
} from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  createDatabasePlugin,
  createUUIDv7,
  rowToBundle,
} from "@hot-updater/plugin-core";

import {
  matchesStandaloneWhere,
  queryStandaloneRows,
} from "./standaloneDatabaseQuery";

export interface RouteConfig {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Routes {
  readonly create?: () => RouteConfig;
  readonly update?: (bundleId: string) => RouteConfig;
  readonly list?: () => RouteConfig;
  readonly channels?: () => RouteConfig;
  readonly retrieve?: (bundleId: string) => RouteConfig;
  readonly delete?: (bundleId: string) => RouteConfig;
}

export interface StandaloneRepositoryConfig {
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
  readonly routes?: Routes;
}

type StandaloneDatabaseErrorCode = "invalid-response" | "request-failed";

export class StandaloneDatabaseError extends Error {
  readonly name = "StandaloneDatabaseError";

  constructor(
    readonly code: StandaloneDatabaseErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const PAGE_SIZE = 100;

const defaultRoutes = {
  create: () => ({ path: "/api/bundles" }),
  update: (bundleId: string) => ({ path: `/api/bundles/${bundleId}` }),
  list: () => ({
    path: "/api/bundles",
    headers: { "Cache-Control": "no-cache" },
  }),
  channels: () => ({
    path: "/api/bundles/channels",
    headers: { "Cache-Control": "no-cache" },
  }),
  retrieve: (bundleId: string) => ({
    path: `/api/bundles/${bundleId}`,
    headers: { Accept: "application/json" },
  }),
  delete: (bundleId: string) => ({ path: `/api/bundles/${bundleId}` }),
};

const appendPathSegment = (path: string, segment: string): string =>
  `${path.replace(/\/+$/, "")}/${segment}`;

const createRoute = (
  defaultRoute: RouteConfig,
  customRoute?: RouteConfig,
): RouteConfig => ({
  path: customRoute?.path ?? defaultRoute.path,
  headers: {
    ...defaultRoute.headers,
    ...customRoute?.headers,
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBundle = (value: unknown): value is Bundle =>
  isRecord(value) &&
  typeof value.id === "string" &&
  (value.platform === "ios" || value.platform === "android") &&
  typeof value.enabled === "boolean" &&
  typeof value.shouldForceUpdate === "boolean" &&
  typeof value.fileHash === "string" &&
  typeof value.channel === "string" &&
  typeof value.storageUri === "string";

const isPaginatedResult = (value: unknown): value is PaginatedResult =>
  isRecord(value) &&
  Array.isArray(value.data) &&
  value.data.every(isBundle) &&
  isRecord(value.pagination);

const hasChannels = (
  value: unknown,
): value is { readonly data: { readonly channels: readonly string[] } } =>
  isRecord(value) &&
  isRecord(value.data) &&
  Array.isArray(value.data.channels) &&
  value.data.channels.every((channel) => typeof channel === "string");

const createLegacyCompatibilityImplementation = (
  config: StandaloneRepositoryConfig,
): DatabasePluginImplementation => {
  const customListRoute = config.routes?.list?.();
  const routes = {
    list: () => createRoute(defaultRoutes.list(), customListRoute),
    channels: () => {
      const defaultChannelsRoute = customListRoute
        ? {
            path: appendPathSegment(customListRoute.path, "channels"),
            headers: {
              ...defaultRoutes.channels().headers,
              ...customListRoute.headers,
            },
          }
        : defaultRoutes.channels();
      return createRoute(defaultChannelsRoute, config.routes?.channels?.());
    },
    create: () =>
      createRoute(defaultRoutes.create(), config.routes?.create?.()),
    update: (bundleId: string) =>
      createRoute(
        defaultRoutes.update(bundleId),
        config.routes?.update?.(bundleId),
      ),
    retrieve: (bundleId: string) =>
      createRoute(
        defaultRoutes.retrieve(bundleId),
        config.routes?.retrieve?.(bundleId),
      ),
    delete: (bundleId: string) =>
      createRoute(
        defaultRoutes.delete(bundleId),
        config.routes?.delete?.(bundleId),
      ),
  };

  const buildUrl = (path: string): string => `${config.baseUrl}${path}`;
  const headers = (routeHeaders?: Readonly<Record<string, string>>) => ({
    "Content-Type": "application/json",
    ...config.commonHeaders,
    ...routeHeaders,
  });
  const requestFailed = async (response: Response): Promise<never> => {
    let message = `Database request failed with status ${response.status}.`;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.message === "string") {
        message = body.message;
      } else if (isRecord(body) && typeof body.error === "string") {
        message = body.error;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new StandaloneDatabaseError(
      "request-failed",
      message,
      response.status,
    );
  };
  const parseJson = async (response: Response): Promise<unknown> => {
    if (!response.ok) return requestFailed(response);
    try {
      return await response.json();
    } catch {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Database response must contain JSON.",
        response.status,
      );
    }
  };

  const loadBundles = async (): Promise<Bundle[]> => {
    const bundles: Bundle[] = [];
    for (let page = 1; ; page += 1) {
      const route = routes.list();
      const url = new URL(buildUrl(route.path));
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const response = await fetch(url, {
        method: "GET",
        headers: headers(route.headers),
      });
      const value = await parseJson(response);
      if (!isPaginatedResult(value)) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Invalid bundle list response.",
          response.status,
        );
      }
      bundles.push(...value.data);
      if (
        value.data.length < PAGE_SIZE ||
        value.pagination.hasNextPage === false ||
        bundles.length >= value.pagination.total
      ) {
        return bundles;
      }
    }
  };

  const loadChannels = async (): Promise<string[]> => {
    const route = routes.channels();
    const response = await fetch(buildUrl(route.path), {
      method: "GET",
      headers: headers(route.headers),
    });
    const value = await parseJson(response);
    if (!hasChannels(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid channels response.",
        response.status,
      );
    }
    return [...value.data.channels];
  };

  const loadBundle = async (bundleId: string): Promise<Bundle | null> => {
    const route = routes.retrieve(bundleId);
    const response = await fetch(buildUrl(route.path), {
      method: "GET",
      headers: headers(route.headers),
    });
    if (response.status === 404) return null;
    const value = await parseJson(response);
    if (!isBundle(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid bundle response.",
        response.status,
      );
    }
    return value;
  };

  const createBundle = async (bundle: Bundle): Promise<void> => {
    const route = routes.create();
    const response = await fetch(buildUrl(route.path), {
      method: "POST",
      headers: headers(route.headers),
      body: JSON.stringify([bundle]),
    });
    await parseJson(response);
  };

  const updateBundle = async (bundle: Bundle): Promise<void> => {
    const route = routes.update(bundle.id);
    const response = await fetch(buildUrl(route.path), {
      method: "PATCH",
      headers: headers(route.headers),
      body: JSON.stringify(bundle),
    });
    await parseJson(response);
  };

  const deleteBundle = async (bundleId: string): Promise<void> => {
    const route = routes.delete(bundleId);
    const response = await fetch(buildUrl(route.path), {
      method: "DELETE",
      headers: headers(route.headers),
    });
    await parseJson(response);
  };

  async function loadRows(model: "bundles"): Promise<BundleRow[]>;
  async function loadRows(model: "bundle_patches"): Promise<BundlePatchRow[]>;
  async function loadRows(model: "channels"): Promise<ChannelRow[]>;
  async function loadRows(
    model: DatabaseModel,
  ): Promise<DatabaseImplementationResult[]> {
    if (model === "channels") {
      return (await loadChannels()).map((name) => ({ id: name, name }));
    }
    const bundles = await loadBundles();
    return model === "bundles"
      ? bundles.map((bundle) => bundleToRow(bundle, bundle.channel))
      : bundles.flatMap(bundleToPatchRows);
  }

  const persistChannel = async (name: string): Promise<ChannelRow> => {
    if ((await loadChannels()).includes(name)) {
      throw new StandaloneDatabaseError(
        "request-failed",
        `Channel ${name} already exists.`,
        409,
      );
    }
    const sentinelId = createUUIDv7();
    const sentinel: Bundle = {
      id: sentinelId,
      platform: "ios",
      shouldForceUpdate: false,
      enabled: false,
      fileHash: `channel:${name}`,
      gitCommitHash: null,
      message: null,
      channel: name,
      storageUri: `channel://${encodeURIComponent(name)}`,
      targetAppVersion: "*",
      fingerprintHash: null,
      metadata: {},
    };
    await createBundle(sentinel);
    await deleteBundle(sentinelId);
    return { id: name, name };
  };

  return {
    async create(input) {
      switch (input.model) {
        case "channels":
          return persistChannel(input.data.name);
        case "bundles":
          if (!(await loadChannels()).includes(input.data.channel_id)) {
            throw new StandaloneDatabaseError(
              "request-failed",
              `Channel ${input.data.channel_id} was not found.`,
              409,
            );
          }
          await createBundle(rowToBundle(input.data, input.data.channel_id));
          return input.data;
        case "bundle_patches": {
          const owner = await loadBundle(input.data.bundle_id);
          if (!owner) {
            throw new StandaloneDatabaseError(
              "request-failed",
              `Bundle ${input.data.bundle_id} was not found.`,
              404,
            );
          }
          if (
            input.data.base_bundle_id !== owner.id &&
            !(await loadBundle(input.data.base_bundle_id))
          ) {
            throw new StandaloneDatabaseError(
              "request-failed",
              `Bundle ${input.data.base_bundle_id} was not found.`,
              404,
            );
          }
          const patches = bundleToPatchRows(owner);
          if (patches.some(({ id }) => id === input.data.id)) {
            throw new StandaloneDatabaseError(
              "request-failed",
              `Bundle patch ${input.data.id} already exists.`,
              409,
            );
          }
          await updateBundle(
            rowToBundle(bundleToRow(owner, owner.channel), owner.channel, [
              ...patches,
              input.data,
            ]),
          );
          return input.data;
        }
      }
    },
    async update(input) {
      const bundleId = String(input.where[0]?.value ?? "");
      const current = await loadBundle(bundleId);
      if (!current) return null;
      const nextRow = {
        ...bundleToRow(current, current.channel),
        ...input.update,
      };
      if (!(await loadChannels()).includes(nextRow.channel_id)) {
        throw new StandaloneDatabaseError(
          "request-failed",
          `Channel ${nextRow.channel_id} was not found.`,
          409,
        );
      }
      const next = rowToBundle(
        nextRow,
        nextRow.channel_id,
        bundleToPatchRows(current),
      );
      await updateBundle(next);
      return nextRow;
    },
    async delete(input) {
      if (input.model === "bundles") {
        const rows = queryStandaloneRows(await loadRows("bundles"), {
          where: input.where,
        });
        for (const row of rows) await deleteBundle(row.id);
        return;
      }
      const bundles = await loadBundles();
      for (const bundle of bundles) {
        const patches = bundleToPatchRows(bundle);
        const remaining = patches.filter(
          (row) => !matchesStandaloneWhere(row, input.where),
        );
        if (remaining.length !== patches.length) {
          await updateBundle(
            rowToBundle(
              bundleToRow(bundle, bundle.channel),
              bundle.channel,
              remaining,
            ),
          );
        }
      }
    },
    async count(input) {
      return queryStandaloneRows(await loadRows("bundles"), {
        where: input.where,
      }).length;
    },
    async findOne(input) {
      if (input.model === "bundles") {
        return (
          queryStandaloneRows(await loadRows("bundles"), {
            where: input.where,
            limit: 1,
          })[0] ?? null
        );
      }
      return (
        queryStandaloneRows(await loadRows("channels"), {
          where: input.where,
          limit: 1,
        })[0] ?? null
      );
    },
    async findMany(input) {
      switch (input.model) {
        case "bundles":
          return queryStandaloneRows(await loadRows("bundles"), {
            where: input.where,
            limit: input.limit,
            offset: input.offset,
            sortBy: input.sortBy,
          });
        case "bundle_patches":
          return queryStandaloneRows(await loadRows("bundle_patches"), {
            where: input.where,
            limit: input.limit,
            offset: input.offset,
            sortBy: input.sortBy,
          });
        case "channels":
          return queryStandaloneRows(await loadRows("channels"), {
            where: input.where,
            limit: input.limit,
            offset: input.offset,
            sortBy: input.sortBy,
          });
      }
    },
  };
};

/**
 * Compatibility bridge over the legacy aggregate `/api/bundles` HTTP API.
 *
 * The channel endpoint exposes names only, so this bridge deterministically
 * aliases each channel name as its low-row `id`. It cannot preserve an
 * independently supplied `ChannelRow.id` and is therefore outside the strict
 * fixed-model v2 adapter conformance contract.
 */
export const standaloneRepository =
  createDatabasePlugin<StandaloneRepositoryConfig>({
    name: "standalone-repository",
    factory: createLegacyCompatibilityImplementation,
  });
