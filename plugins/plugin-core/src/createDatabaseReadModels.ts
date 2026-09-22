import { DatabasePluginInputError } from "./databasePluginCrudValidation";
import { createDatabasePluginReads } from "./databasePluginReads";
import type {
  BundleRow,
  BundlePatchRow,
  ReleaseRow,
  ReleaseCatalogRow,
  DatabaseBundleQueryWhere,
  DatabaseWhere,
  DatabaseReadImplementation,
  DatabasePlugin,
} from "./types/internal";

const PAGE_SIZE = 100;

const toBundleWhere = (
  where: DatabaseBundleQueryWhere | undefined,
): readonly DatabaseWhere<"bundles">[] => {
  if (!where) return [];
  const filters: DatabaseWhere<"bundles">[] = [];
  if (where.platform !== undefined)
    filters.push({ field: "platform", value: where.platform });
  if (where.id?.eq !== undefined)
    filters.push({ field: "id", value: where.id.eq });
  if (where.id?.gt !== undefined)
    filters.push({ field: "id", operator: "gt", value: where.id.gt });
  if (where.id?.gte !== undefined)
    filters.push({ field: "id", operator: "gte", value: where.id.gte });
  if (where.id?.lt !== undefined)
    filters.push({ field: "id", operator: "lt", value: where.id.lt });
  if (where.id?.lte !== undefined)
    filters.push({ field: "id", operator: "lte", value: where.id.lte });
  if (where.id?.in !== undefined)
    filters.push({ field: "id", operator: "in", value: where.id.in });
  return filters;
};

/** Query planning shared by SQL and native providers; execution stays in storage. */
export const createDatabaseReadModels = (
  implementation: DatabaseReadImplementation,
  bundlePatches?: DatabasePlugin["models"]["bundlePatches"],
): Pick<
  DatabasePlugin["models"],
  "bundles" | "bundlePatches" | "releases" | "releaseCatalogs"
> => {
  const crud = createDatabasePluginReads(implementation);
  return {
    bundles: {
      findById: (id): Promise<BundleRow | null> =>
        crud.findOne({
          model: "bundles",
          where: [{ field: "id", value: id }],
        }),
      findMany: (query): Promise<readonly BundleRow[]> =>
        crud.findMany({
          model: "bundles",
          where: toBundleWhere(query.where),
          limit: query.limit,
          offset: query.offset,
          orderBy: [query.orderBy],
        }),
      count: (where) =>
        crud.count({ model: "bundles", where: toBundleWhere(where) }),
    },
    bundlePatches: bundlePatches ?? {
      async findByBaseBundleIds(
        baseBundleIds,
      ): Promise<readonly BundlePatchRow[]> {
        const rows: BundlePatchRow[] = [];
        for (const baseBundleId of new Set(baseBundleIds)) {
          let after: string | undefined;
          while (true) {
            const where: DatabaseWhere<"bundle_patches">[] = [
              { field: "base_bundle_id", value: baseBundleId },
            ];
            if (after !== undefined)
              where.push({ field: "id", operator: "gt", value: after });
            const page = await crud.findMany({
              model: "bundle_patches",
              where,
              limit: PAGE_SIZE,
              offset: 0,
              orderBy: [{ field: "id", direction: "asc" }],
            });
            rows.push(...page);
            if (page.length < PAGE_SIZE) break;
            after = page[page.length - 1].id;
          }
        }
        return rows;
      },
      async findByBundleIds(bundleIds): Promise<readonly BundlePatchRow[]> {
        if (bundleIds.length === 0) return [];
        const rows: BundlePatchRow[] = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const page = await crud.findMany({
            model: "bundle_patches",
            where: [{ field: "bundle_id", operator: "in", value: bundleIds }],
            limit: PAGE_SIZE,
            offset,
            orderBy: [{ field: "id", direction: "asc" }],
          });
          rows.push(...page);
          if (page.length < PAGE_SIZE) return rows;
        }
      },
    },
    releases: {
      findById: (id): Promise<ReleaseRow | null> =>
        crud.findOne({
          model: "releases",
          where: [{ field: "id", value: id }],
        }),
      findMany(input): Promise<readonly ReleaseRow[]> {
        if (
          !Number.isSafeInteger(input.limit) ||
          input.limit <= 0 ||
          (input.afterReleaseId !== undefined &&
            input.beforeReleaseId !== undefined)
        ) {
          throw new DatabasePluginInputError("invalid-query");
        }
        const query = crud.findMany({
          model: "releases",
          where: [
            ...(input.afterReleaseId === undefined
              ? []
              : [
                  {
                    field: "id" as const,
                    operator: "gt" as const,
                    value: input.afterReleaseId,
                  },
                ]),
            ...(input.beforeReleaseId === undefined
              ? []
              : [
                  {
                    field: "id" as const,
                    operator: "lt" as const,
                    value: input.beforeReleaseId,
                  },
                ]),
            ...(input.bundleId === undefined
              ? []
              : [{ field: "bundle_id" as const, value: input.bundleId }]),
            ...(input.channelId === undefined
              ? []
              : [{ field: "channel_id" as const, value: input.channelId }]),
            ...(input.enabled === undefined
              ? []
              : [{ field: "enabled" as const, value: input.enabled }]),
            ...(input.platform === undefined
              ? []
              : [{ field: "platform" as const, value: input.platform }]),
            ...(input.targetAppVersion === undefined
              ? []
              : [
                  {
                    field: "target_app_version" as const,
                    value: input.targetAppVersion,
                  },
                ]),
          ],
          limit: input.limit,
          offset: 0,
          orderBy: [
            {
              field: "id",
              direction:
                input.afterReleaseId === undefined
                  ? ("desc" as const)
                  : ("asc" as const),
            },
          ],
        });
        return input.afterReleaseId === undefined
          ? query
          : query.then((rows) => [...rows].reverse());
      },
      findManyByScope(input): Promise<readonly ReleaseRow[]> {
        if (
          input.consistency !== "strong" ||
          !Number.isSafeInteger(input.limit) ||
          input.limit <= 0
        ) {
          throw new DatabasePluginInputError("invalid-query");
        }
        return crud.findMany({
          model: "releases",
          where: [
            { field: "scope_key", value: input.scopeKey },
            ...(input.afterReleaseId === undefined
              ? []
              : [
                  {
                    field: "id" as const,
                    operator: "gt" as const,
                    value: input.afterReleaseId,
                  },
                ]),
          ],
          limit: input.limit,
          offset: 0,
          orderBy: [{ field: "id", direction: "asc" }],
        });
      },
    },
    releaseCatalogs: {
      findByScopeKey: (scopeKey): Promise<ReleaseCatalogRow | null> =>
        crud.findOne({
          model: "release_catalogs",
          where: [{ field: "scope_key", value: scopeKey }],
        }),
      findMany(input): Promise<readonly ReleaseCatalogRow[]> {
        if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
          throw new DatabasePluginInputError("invalid-query");
        }
        return crud.findMany({
          model: "release_catalogs",
          where:
            input.afterScopeKey === undefined
              ? []
              : [
                  {
                    field: "scope_key",
                    operator: "gt",
                    value: input.afterScopeKey,
                  },
                ],
          limit: input.limit,
          offset: 0,
          orderBy: [{ field: "scope_key", direction: "asc" }],
        });
      },
    },
  };
};
