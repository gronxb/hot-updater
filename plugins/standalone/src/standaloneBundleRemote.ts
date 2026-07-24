import type {
  Bundle,
  BundleRow,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";
import { bundleToRow } from "@hot-updater/plugin-core";

import { appendBundleWhere } from "./standaloneBundleWhere";
import {
  createStandaloneHttp,
  StandaloneDatabaseError,
} from "./standaloneHttp";
import {
  hasChannels,
  isBundle,
  isPaginatedResult,
} from "./standaloneResponseGuards";
import {
  appendPathSegment,
  createRoute,
  defaultRoutes,
  type StandaloneRepositoryConfig,
} from "./standaloneRoutes";

const PAGE_SIZE = 100;

export interface BundleWindowInput {
  readonly where?: readonly DatabaseWhere<"bundles">[];
  readonly limit: number;
  readonly offset: number;
  readonly sortBy?: DatabaseSortBy<"bundles">;
}

export const createStandaloneBundleRemote = (
  config: StandaloneRepositoryConfig,
) => {
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
  const http = createStandaloneHttp(config);

  const loadBundles = async (): Promise<Bundle[]> => {
    const bundles: Bundle[] = [];
    for (let page = 1; ; page += 1) {
      const route = routes.list();
      const response = await http.request(route, {
        method: "GET",
        searchParams: new URLSearchParams({
          limit: String(PAGE_SIZE),
          page: String(page),
        }),
      });
      const value = await http.parseJson(response);
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

  const loadBundleWindow = async (input: BundleWindowInput) => {
    if (input.limit === 0) return { rows: [] as BundleRow[], total: 0 };
    if (input.sortBy && input.sortBy.field !== "id") {
      return null;
    }
    const route = routes.list();
    const searchParams = new URLSearchParams();
    if (!appendBundleWhere(searchParams, input.where)) return null;
    if (input.sortBy !== undefined) {
      searchParams.set("orderDirection", input.sortBy.direction);
    }
    const pageAligned = input.limit > 0 && input.offset % input.limit === 0;
    const remoteLimit = pageAligned ? input.limit : input.offset + input.limit;
    if (remoteLimit > PAGE_SIZE) return null;
    searchParams.set("limit", String(remoteLimit));
    searchParams.set(
      "page",
      String(pageAligned ? input.offset / input.limit + 1 : 1),
    );
    const response = await http.request(route, {
      method: "GET",
      searchParams,
    });
    const value = await http.parseJson(response);
    if (!isPaginatedResult(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid bundle list response.",
        response.status,
      );
    }
    const bundles = pageAligned
      ? value.data
      : value.data.slice(input.offset, input.offset + input.limit);
    return {
      rows: bundles.map(bundleToRow),
      total: value.pagination.total,
    };
  };

  const loadChannels = async (): Promise<string[]> => {
    const route = routes.channels();
    const response = await http.request(route, {
      method: "GET",
    });
    const value = await http.parseJson(response);
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
    const response = await http.request(route, {
      method: "GET",
    });
    if (response.status === 404) return null;
    const value = await http.parseJson(response);
    if (!isBundle(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid bundle response.",
        response.status,
      );
    }
    return value;
  };

  const updateBundle = async (bundle: Bundle): Promise<void> => {
    const route = routes.update(bundle.id);
    const response = await http.request(route, {
      method: "PATCH",
      body: JSON.stringify(bundle),
    });
    await http.parseJson(response);
  };

  const createBundles = async (bundles: readonly Bundle[]): Promise<void> => {
    const route = routes.create();
    const response = await http.request(route, {
      method: "POST",
      body: JSON.stringify(bundles),
    });
    await http.parseJson(response);
  };

  const deleteBundle = async (bundleId: string): Promise<void> => {
    const route = routes.delete(bundleId);
    const response = await http.request(route, {
      method: "DELETE",
    });
    await http.parseJson(response);
  };

  return {
    createBundle: (bundle: Bundle) => createBundles([bundle]),
    createBundles,
    deleteBundle,
    loadBundle,
    loadBundles,
    loadBundleWindow,
    loadChannels,
    updateBundle,
  };
};

export type StandaloneBundleRemote = ReturnType<
  typeof createStandaloneBundleRemote
>;
