import {
  DatabasePluginInputError,
  type BundleModelQuery,
  type BundleRow,
  type DatabaseBundleQueryWhere,
  type DatabaseModels,
  type ReleaseCatalogRow,
  type ReleaseModel,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import {
  commitLegacyChanges,
  compiledGeneration,
  coreModule,
  coreSchema,
  createCoreReads,
  deleteChannel,
  insertChannel,
  toBundleRow,
  toCatalogRow,
  toReleaseRow,
  type ExternalChange,
} from "../core";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { apiKeys, apiKeysSchema, createApiKeyModel } from "../plugins/api-keys";
import {
  createInsightsModel,
  insights,
  insightsSchema,
} from "../plugins/insights";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { createDatabaseEngine, type HotUpdaterTransaction } from "./database";
import type { Page } from "./engineReads";
import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  migrateSchema,
  withSchemaFence,
  type SchemaSettings,
} from "./fence";
import { resolveSchema } from "./resolveSchema";

const insightsModule = { id: "insights", schema: insightsSchema } as const;
const apiKeysModule = { id: "apiKeys", schema: apiKeysSchema } as const;
/** Core's and the API keys plugin's tables, for commits that span both. */
const commitModule = {
  id: "legacy",
  schema: { ...coreSchema, ...apiKeysSchema },
} as const;

/** Every table today's `DatabasePlugin` spans: core, Insights, and API keys. */
export const legacyFacadeSchema = resolveSchema([
  coreModule,
  insightsModule,
  apiKeysModule,
]);

/** The settings rows the façade's tables are fenced by. */
export const legacyFacadeSettings: SchemaSettings = {
  [ENGINE_SCHEMA_KEY]: ENGINE_SCHEMA_VERSION,
  "schema.core": HOT_UPDATER_SCHEMA_VERSION,
  "schema.insights": insights().schemaVersion,
  "schema.apiKeys": apiKeys().schemaVersion,
};

/** Creates the façade's tables, then writes its settings rows. */
export const migrateLegacyFacade = (adapter: DatabaseAdapter, name: string) =>
  migrateSchema(adapter, name, legacyFacadeSchema.tables, legacyFacadeSettings);

const PAGE = 500;

type Bound = string | undefined;
const tighter = (
  left: Bound,
  right: Bound,
  pick: (a: string, b: string) => boolean,
) =>
  left === undefined
    ? right
    : right === undefined || pick(left, right)
      ? left
      : right;

interface IdRange {
  readonly gt?: string;
  readonly gte?: string;
  readonly lt?: string;
  readonly lte?: string;
}

/** Legacy id bounds as one engine range; `gt` beats an equal `gte`. */
const idRange = (id: DatabaseBundleQueryWhere["id"]): IdRange => {
  const lower = id?.eq ?? tighter(id?.gt, id?.gte, (gt, gte) => gt >= gte);
  const upper = id?.eq ?? tighter(id?.lt, id?.lte, (lt, lte) => lt <= lte);
  const strictLower =
    id?.eq === undefined && lower !== undefined && lower === id?.gt;
  const strictUpper =
    id?.eq === undefined && upper !== undefined && upper === id?.lt;
  return {
    ...(lower === undefined
      ? {}
      : strictLower
        ? { gt: lower }
        : { gte: lower }),
    ...(upper === undefined
      ? {}
      : strictUpper
        ? { lt: upper }
        : { lte: upper }),
  };
};

/**
 * Pages through one index, keeping rows `keep` accepts, until `offset + limit`
 * are kept. Legacy queries filter and skip in code; the façade is removed in
 * E2 with the offset and filter shapes that need it.
 */
const scan = async <T>(
  read: (cursor: string | undefined) => Promise<Page<T>>,
  keep: (row: T) => boolean,
  offset: number,
  limit: number,
): Promise<T[]> => {
  const kept: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    kept.push(...page.rows.filter(keep));
    cursor = page.next;
  } while (cursor !== undefined && kept.length < offset + limit);
  return kept.slice(offset, offset + limit);
};

const checkLimit = (limit: number, offset = 0) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new DatabasePluginInputError("invalid-pagination");
  }
};

/**
 * Today's `DatabasePlugin` over the engine, core, and the built-in Insights
 * and API keys plugins, until E2 retires the legacy contract.
 */
export const createLegacyDatabasePlugin = (options: {
  readonly name: string;
  readonly adapter: DatabaseAdapter;
  /** Check the schema settings before the first read; each provider turns it on in its D PR. */
  readonly fence?: boolean;
  readonly now?: () => number;
}): DatabaseAdapterWithCapabilities => {
  const adapter = options.fence
    ? withSchemaFence(options.adapter, options.name, legacyFacadeSettings)
    : options.adapter;
  const engine = createDatabaseEngine({ adapter, schema: legacyFacadeSchema });
  const core = engine.database(coreModule);
  const reads = createCoreReads(core, { resolveFileUrl: async () => null });
  const insightsApi = insights().init({
    db: engine.database(insightsModule),
    core: reads,
    now: options.now ?? Date.now,
  }).api;

  const bundleMatches = (where: DatabaseBundleQueryWhere | undefined) => {
    const range = idRange(where?.id);
    return (row: BundleRow) =>
      (where?.platform === undefined || row.platform === where.platform) &&
      (where?.id?.in === undefined || where.id.in.includes(row.id)) &&
      (range.gt === undefined || row.id > range.gt) &&
      (range.gte === undefined || row.id >= range.gte) &&
      (range.lt === undefined || row.id < range.lt) &&
      (range.lte === undefined || row.id <= range.lte);
  };

  /** Bundles matching `where`, in id order, from the platform index or a batch read. */
  const findBundles = async (
    where: DatabaseBundleQueryWhere | undefined,
    order: "asc" | "desc",
    offset: number,
    limit: number,
  ): Promise<BundleRow[]> => {
    const matches = bundleMatches(where);
    if (where?.id?.in !== undefined) {
      const rows = (
        await core.findByKeys(
          "bundles",
          [...new Set(where.id.in)].map((id) => ({ id })),
        )
      )
        .filter((row) => row !== null)
        .map(toBundleRow)
        .filter(matches)
        .sort(
          (left, right) =>
            (left.id < right.id ? -1 : 1) * (order === "asc" ? 1 : -1),
        );
      return rows.slice(offset, offset + limit);
    }
    const range = idRange(where?.id);
    const bounds = Object.keys(range).length === 0 ? {} : { range };
    return scan(
      (cursor) =>
        (where?.platform === undefined
          ? core.findMany("bundles", {
              index: "all",
              where: {},
              order,
              limit: PAGE,
              ...bounds,
              ...(cursor === undefined ? {} : { cursor }),
            })
          : core.findMany("bundles", {
              index: "byPlatform",
              where: { platform: where.platform },
              order,
              limit: PAGE,
              ...bounds,
              ...(cursor === undefined ? {} : { cursor }),
            })
        ).then((page) => ({ ...page, rows: page.rows.map(toBundleRow) })),
      matches,
      offset,
      limit,
    );
  };

  const findReleases: ReleaseModel["findMany"] = async (input) => {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      (input.afterReleaseId !== undefined &&
        input.beforeReleaseId !== undefined)
    ) {
      throw new DatabasePluginInputError("invalid-query");
    }
    const order: "asc" | "desc" =
      input.afterReleaseId === undefined ? "desc" : "asc";
    const range =
      input.afterReleaseId !== undefined
        ? { range: { gt: input.afterReleaseId } }
        : input.beforeReleaseId !== undefined
          ? { range: { lt: input.beforeReleaseId } }
          : {};
    const page = (cursor: string | undefined) => ({
      order,
      limit: PAGE,
      ...range,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const read = (cursor: string | undefined) =>
      input.bundleId !== undefined
        ? core.findMany("releases", {
            index: "byBundle",
            where: { bundle_id: input.bundleId },
            ...page(cursor),
          })
        : input.channelId !== undefined &&
            input.platform !== undefined &&
            input.enabled !== undefined
          ? core.findMany("releases", {
              index: "byChannelPlatformEnabled",
              where: {
                channel_id: input.channelId,
                platform: input.platform,
                enabled: input.enabled,
              },
              ...page(cursor),
            })
          : input.channelId !== undefined && input.platform !== undefined
            ? core.findMany("releases", {
                index: "byChannelPlatform",
                where: {
                  channel_id: input.channelId,
                  platform: input.platform,
                },
                ...page(cursor),
              })
            : core.findMany("releases", {
                index: "all",
                where: {},
                ...page(cursor),
              });
    const rows = await scan(
      (cursor) =>
        read(cursor).then((result) => ({
          ...result,
          rows: result.rows.map(toReleaseRow),
        })),
      (row: ReleaseRow) =>
        (input.bundleId === undefined || row.bundle_id === input.bundleId) &&
        (input.channelId === undefined || row.channel_id === input.channelId) &&
        (input.enabled === undefined || row.enabled === input.enabled) &&
        (input.platform === undefined || row.platform === input.platform) &&
        (input.targetAppVersion === undefined ||
          row.target_app_version === input.targetAppVersion),
      0,
      input.limit,
    );
    return order === "asc" ? rows.reverse() : rows;
  };

  const apiKeyChange = async (
    tx: HotUpdaterTransaction<typeof commitModule.schema>,
    change: ExternalChange,
  ): Promise<"not_found" | undefined> => {
    if (change.operation === "insert") {
      // onConflict "ignore": a taken id or hash leaves the stored key.
      if (await tx.findOne("api_keys", { id: change.row.id })) return;
      if (await tx.findOne("api_keys", { hash: change.row.hash })) return;
      tx.create("api_keys", change.row);
      return;
    }
    const row = await tx.findOne("api_keys", { id: change.where.id });
    if (row === null) return "not_found";
    tx.update("api_keys", row, { revoked_at_ms: change.update.revokedAtMs });
    return;
  };

  const models: DatabaseModels = {
    bundles: {
      async findById(id) {
        const row = await core.findOne("bundles", { id });
        return row === null ? null : toBundleRow(row);
      },
      async findMany({ where, limit, offset, orderBy }: BundleModelQuery) {
        checkLimit(limit, offset);
        return findBundles(where, orderBy.direction, offset, limit);
      },
      async count(where) {
        if (where?.id === undefined) return reads.countBundles(where?.platform);
        return (await findBundles(where, "asc", 0, Number.MAX_SAFE_INTEGER))
          .length;
      },
    },
    bundlePatches: {
      async findByBundleIds(bundleIds) {
        const details = await Promise.all(
          [...new Set(bundleIds)].map((id) => reads.getBundle(id)),
        );
        return details
          .flatMap((detail) => detail?.patches ?? [])
          .sort((left, right) => (left.id < right.id ? -1 : 1));
      },
    },
    releases: {
      findById: (id) => reads.getRelease(id),
      findMany: findReleases,
      async findManyByScope(input) {
        if (
          input.consistency !== "strong" ||
          !Number.isSafeInteger(input.limit) ||
          input.limit <= 0
        ) {
          throw new DatabasePluginInputError("invalid-query");
        }
        return scan(
          (cursor) =>
            core
              .findMany("releases", {
                index: "byScope",
                where: { scope_key: input.scopeKey },
                limit: Math.min(input.limit, PAGE),
                ...(input.afterReleaseId === undefined
                  ? {}
                  : { range: { gt: input.afterReleaseId } }),
                ...(cursor === undefined ? {} : { cursor }),
              })
              .then((page) => ({ ...page, rows: page.rows.map(toReleaseRow) })),
          () => true,
          0,
          input.limit,
        );
      },
    },
    releaseCatalogs: {
      findByScopeKey: (scopeKey) => reads.getReleaseCatalogRow(scopeKey),
      async findMany(input) {
        if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
          throw new DatabasePluginInputError("invalid-query");
        }
        // Placeholder catalogs of legacy raw commits stay hidden.
        return scan(
          (cursor) =>
            core
              .findMany("release_catalogs", {
                index: "all",
                where: {},
                limit: PAGE,
                ...(input.afterScopeKey === undefined
                  ? {}
                  : { range: { gt: input.afterScopeKey } }),
                ...(cursor === undefined ? {} : { cursor }),
              })
              .then((page) => ({ ...page, rows: page.rows })),
          (row) => compiledGeneration(row) !== null,
          0,
          input.limit,
        ).then((rows): ReleaseCatalogRow[] => rows.map(toCatalogRow));
      },
    },
    channels: {
      async insert(input) {
        if (input.onConflict !== "returnExisting") {
          throw new DatabasePluginInputError("invalid-operation");
        }
        return insertChannel(core, input.row);
      },
      list: async () => ({ channels: await reads.listChannels() }),
      delete: ({ id }) => deleteChannel(core, id),
    },
    insights: createInsightsModel(insightsApi),
    apiKeys: createApiKeyModel(engine.database(apiKeysModule)),
  };

  return {
    name: options.name,
    models,
    commit: (input) =>
      commitLegacyChanges(engine.database(commitModule), input, apiKeyChange),
    engineAdapter: adapter,
    ...(adapter.dispose === undefined
      ? {}
      : { dispose: () => adapter.dispose!() }),
  };
};
