import type {
  BundlePatchRow,
  Bundle,
  BundleRow,
  ChannelRow,
} from "@hot-updater/plugin-core";
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
  hasBundlePatchRows,
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
    if (
      input.limit === 0 ||
      (!input.where?.some(({ connector }) => connector === "OR") &&
        input.where?.some(
          ({ operator, value }) =>
            operator === "in" && Array.isArray(value) && value.length === 0,
        ))
    )
      return { rows: [] as BundleRow[], total: 0 };
    if (input.orderBy && input.orderBy.field !== "id") {
      return null;
    }
    const route = routes.list();
    const url = new URL(http.buildUrl(route.path));
    if (!appendBundleWhere(url, input.where)) return null;
    if (input.orderBy !== undefined) {
      url.searchParams.set("orderDirection", input.orderBy.direction);
    }
    // Fetch only pages intersecting the requested window, including unaligned offsets.
    const remoteLimit = Math.min(PAGE_SIZE, input.limit);
    const rows: BundleRow[] = [];
    let total = 0;
    let offset = input.offset;
    while (rows.length < input.limit) {
      const page = Math.floor(offset / remoteLimit) + 1;
      const skip = offset % remoteLimit;
      url.searchParams.set("limit", String(remoteLimit));
      url.searchParams.set("page", String(page));
      const response = await fetch(url, {
        method: "GET",
        headers: http.headers(route.headers),
      });
      const value = await http.parseJson(response);
      if (!isPaginatedResult(value))
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Invalid bundle list response.",
          response.status,
        );
      total = value.pagination.total;
      const selected = value.data.slice(skip, skip + input.limit - rows.length);
      rows.push(...(await bundlesToRows(selected)));
      if (
        !value.pagination.hasNextPage ||
        value.data.length === 0 ||
        offset + selected.length >= total
      )
        break;
      offset = page * remoteLimit;
    }
    return { rows, total };
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

  const loadPatchChildren = async (
    baseBundleIds: readonly string[],
  ): Promise<readonly BundlePatchRow[]> => {
    const rows: BundlePatchRow[] = [];
    for (const id of new Set(baseBundleIds)) {
      const route = createRoute(
        defaultRoutes.patchChildren(id),
        config.routes?.patchChildren?.(id),
      );
      const response = await fetch(http.buildUrl(route.path), {
        headers: http.headers(route.headers),
      });
      const value = await http.parseJson(response);
      if (
        !hasBundlePatchRows(value) ||
        value.data.some((row) => row.base_bundle_id !== id)
      )
        throw new StandaloneDatabaseError(
          "invalid-response",
          "Invalid patch children response.",
          response.status,
        );
      rows.push(...value.data);
    }
    return rows;
  };

  return {
    loadPatchChildren,
    createBundle: (bundle: Bundle) => createBundles([bundle]),
    createBundles,
    deleteBundle,
    deleteChannel,
    insertChannel,
    loadBundle,
    loadBundleRow,
    loadBundleWindow,
    loadChannels,
    updateBundle,
  };
};

export type StandaloneBundleRemote = ReturnType<
  typeof createStandaloneBundleRemote
>;
