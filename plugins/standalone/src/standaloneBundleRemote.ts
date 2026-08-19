import type { Bundle, BundleRow, ChannelRow } from "@hot-updater/plugin-core";
import { bundleToRow } from "@hot-updater/plugin-core";
import type {
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

import { appendBundleWhere } from "./standaloneBundleWhere";
import {
  createStandaloneHttp,
  StandaloneDatabaseError,
} from "./standaloneHttp";
import {
  hasChannels,
  hasChannelInsertResult,
  hasChannelDeleteResult,
  isBundle,
  isPaginatedResult,
} from "./standaloneResponseGuards";
import {
  createRoute,
  defaultRoutes,
  type StandaloneRepositoryConfig,
} from "./standaloneRoutes";

const PAGE_SIZE = 100;

export interface BundleWindowInput {
  readonly where?: readonly DatabaseWhere<"bundles">[];
  readonly limit: number;
  readonly offset: number;
  readonly orderBy?: DatabaseSortBy<"bundles">;
}

export const createStandaloneBundleRemote = (
  config: StandaloneRepositoryConfig,
) => {
  const routes = {
    list: () => createRoute(defaultRoutes.list(), config.routes?.list?.()),
    channels: defaultRoutes.channels,
    deleteChannel: defaultRoutes.deleteChannel,
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
      const url = new URL(http.buildUrl(route.path));
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const response = await fetch(url, {
        method: "GET",
        headers: http.headers(route.headers),
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

  const loadChannels = async (): Promise<readonly ChannelRow[]> => {
    const route = routes.channels();
    const response = await fetch(http.buildUrl(route.path), {
      method: "GET",
      headers: http.headers(route.headers),
    });
    const value = await http.parseJson(response);
    if (!hasChannels(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid channels response.",
        response.status,
      );
    }
    return value.data.channels;
  };

  const bundlesToRows = async (
    bundles: readonly Bundle[],
  ): Promise<BundleRow[]> => bundles.map((bundle) => bundleToRow(bundle));

  const loadBundleWindow = async (input: BundleWindowInput) => {
    if (input.limit === 0) return { rows: [] as BundleRow[], total: 0 };
    if (input.orderBy && input.orderBy.field !== "id") {
      return null;
    }
    const route = routes.list();
    const url = new URL(http.buildUrl(route.path));
    if (!appendBundleWhere(url, input.where)) return null;
    if (input.orderBy !== undefined) {
      url.searchParams.set("orderDirection", input.orderBy.direction);
    }
    const pageAligned = input.limit > 0 && input.offset % input.limit === 0;
    const remoteLimit = pageAligned ? input.limit : input.offset + input.limit;
    if (remoteLimit > PAGE_SIZE) return null;
    url.searchParams.set("limit", String(remoteLimit));
    url.searchParams.set(
      "page",
      String(pageAligned ? input.offset / input.limit + 1 : 1),
    );
    const response = await fetch(url, {
      method: "GET",
      headers: http.headers(route.headers),
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
      rows: await bundlesToRows(bundles),
      total: value.pagination.total,
    };
  };

  const insertChannel = async (
    input: import("@hot-updater/plugin-core").ChannelInsertInput,
  ): Promise<import("@hot-updater/plugin-core").ChannelInsertResult> => {
    const route = routes.channels();
    const response = await fetch(http.buildUrl(route.path), {
      method: "POST",
      headers: http.headers(route.headers),
      body: JSON.stringify(input),
    });
    const value = await http.parseJson(response);
    if (!hasChannelInsertResult(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid Channel insert response.",
        response.status,
      );
    }
    if (
      value.data.row.name !== input.row.name ||
      (value.data.inserted && value.data.row.id !== input.row.id)
    ) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid Channel insert response.",
        response.status,
      );
    }
    return value.data;
  };

  const deleteChannel = async (
    input: import("@hot-updater/plugin-core").ChannelDeleteInput,
  ): Promise<import("@hot-updater/plugin-core").ChannelDeleteResult> => {
    const route = routes.deleteChannel(input.id);
    const response = await fetch(http.buildUrl(route.path), {
      method: "DELETE",
      headers: http.headers(route.headers),
    });
    if (response.status === 204) return { deleted: true };
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Database response must contain JSON.",
        response.status,
      );
    }
    if (!hasChannelDeleteResult(value)) {
      throw new StandaloneDatabaseError(
        "invalid-response",
        "Invalid Channel delete response.",
        response.status,
      );
    }
    return value.data;
  };

  const loadBundle = async (bundleId: string): Promise<Bundle | null> => {
    const route = routes.retrieve(bundleId);
    const response = await fetch(http.buildUrl(route.path), {
      method: "GET",
      headers: http.headers(route.headers),
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

  const loadBundleRow = async (bundleId: string): Promise<BundleRow | null> => {
    const bundle = await loadBundle(bundleId);
    return bundle ? ((await bundlesToRows([bundle]))[0] ?? null) : null;
  };

  const loadBundleRows = async (): Promise<BundleRow[]> =>
    bundlesToRows(await loadBundles());

  const updateBundle = async (bundle: Bundle): Promise<void> => {
    const route = routes.update(bundle.id);
    const response = await fetch(http.buildUrl(route.path), {
      method: "PATCH",
      headers: http.headers(route.headers),
      body: JSON.stringify(bundle),
    });
    await http.parseJson(response);
  };

  const createBundles = async (bundles: readonly Bundle[]): Promise<void> => {
    const route = routes.create();
    const response = await fetch(http.buildUrl(route.path), {
      method: "POST",
      headers: http.headers(route.headers),
      body: JSON.stringify(bundles),
    });
    await http.parseJson(response);
  };

  const deleteBundle = async (bundleId: string): Promise<void> => {
    const route = routes.delete(bundleId);
    const response = await fetch(http.buildUrl(route.path), {
      method: "DELETE",
      headers: http.headers(route.headers),
    });
    await http.parseJson(response);
  };

  return {
    createBundle: (bundle: Bundle) => createBundles([bundle]),
    createBundles,
    deleteBundle,
    deleteChannel,
    insertChannel,
    loadBundle,
    loadBundleRow,
    loadBundleRows,
    loadBundles,
    loadBundleWindow,
    loadChannels,
    updateBundle,
  };
};

export type StandaloneBundleRemote = ReturnType<
  typeof createStandaloneBundleRemote
>;
