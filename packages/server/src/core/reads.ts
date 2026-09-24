import {
  ARTIFACT_PROTOCOL_VERSION,
  NIL_UUID,
  type ArtifactInfo,
  type ReleaseCatalog,
} from "@hot-updater/core";
import {
  rowToBundle,
  type BundleDetail,
  type BundlePatchRow,
  type BundleRow,
  type ChannelRow,
  type KeysetInput,
  type ReleaseCatalogRow,
  type ReleaseFilter,
  type ReleaseRow,
} from "@hot-updater/plugin-core";

import type { HotUpdaterDatabase, ReadRow } from "../database/database";
import type { Page } from "../database/engineReads";
import {
  projectReleaseCatalogRow,
  releaseCatalogScopeKeyOf,
  type ReleaseCatalogRequest,
} from "../db/releaseCatalog";
import { resolveManifestArtifacts } from "../db/updateArtifacts";
import type { CoreSchema } from "./schema";

export type CoreDatabase = HotUpdaterDatabase<CoreSchema>;
export type { BundleDetail, KeysetInput, ReleaseFilter };

const PAGE = 500;

const pick =
  <T>(fields: readonly (keyof T & string)[]) =>
  (row: Readonly<Record<string, unknown>>): T =>
    Object.fromEntries(fields.map((field) => [field, row[field]])) as T;

export const toBundleRow = pick<BundleRow>([
  "id",
  "platform",
  "git_commit_hash",
  "metadata",
  "manifest_storage_uri",
  "manifest_file_hash",
  "asset_base_storage_uri",
]);

export const toPatchRow = pick<BundlePatchRow>([
  "id",
  "bundle_id",
  "base_bundle_id",
  "base_file_hash",
  "patch_file_hash",
  "patch_storage_uri",
  "byte_size",
  "order_index",
]);

export const toReleaseRow = pick<ReleaseRow>([
  "id",
  "revision",
  "scope_key",
  "channel_id",
  "platform",
  "kind",
  "bundle_id",
  "strategy",
  "target_app_version",
  "fingerprint_hash",
  "enabled",
  "should_force_update",
  "message",
  "rollout_cohort_count",
  "target_cohorts",
  "operation",
  "source_release_id",
  "created_at_ms",
  "updated_at_ms",
]);

export const toCatalogRow = pick<ReleaseCatalogRow>([
  "scope_key",
  "catalog_id",
  "strategy",
  "channel_id",
  "channel_key",
  "platform",
  "fingerprint_hash",
  "generation",
  "payload",
  "catalog_hash",
  "byte_size",
  "is_tombstone",
  "updated_at_ms",
]);

export const toChannelRow = pick<ChannelRow>(["id", "name"]);

/** Every page of one read, in order. */
export const drain = async <T>(
  read: (page: { readonly cursor?: string }) => Promise<Page<T>>,
): Promise<T[]> => {
  const rows: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor === undefined ? {} : { cursor });
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor !== undefined);
  return rows;
};

export interface CoreStorage {
  readonly readStorageText?: (storageUri: string) => Promise<string | null>;
  readonly resolveFileUrl: (
    storageUri: string | null,
  ) => Promise<string | null>;
}

/** Core's reads, each through one declared index or key. */
export const createCoreReads = (db: CoreDatabase, storage: CoreStorage) => {
  /** A bundle row's patches, exactly as many as its reference counter holds. */
  const detail = async (
    row: ReadRow<CoreSchema["bundles"]>,
  ): Promise<BundleDetail> => {
    const count = row._refs_bundle_patches_bundle_id ?? 0;
    const patches: BundlePatchRow[] = [];
    let cursor: string | undefined;
    while (patches.length < count) {
      const page = await db.findMany("bundle_patches", {
        index: "byBundle",
        where: { bundle_id: row.id },
        limit: Math.min(count - patches.length, PAGE),
        ...(cursor === undefined ? {} : { cursor }),
      });
      patches.push(...page.rows.map(toPatchRow));
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return {
      bundle: toBundleRow(row),
      patches,
      // a reference counter, so cascades cannot make it drift
      childCount: row._refs_bundle_patches_base_bundle_id ?? 0,
    };
  };

  const after = (input: KeysetInput) =>
    input.after === undefined
      ? {}
      : {
          range:
            (input.order ?? "asc") === "asc"
              ? { gt: input.after }
              : { lt: input.after },
        };

  return {
    /** The update check: one point read of its scope's catalog. */
    async getReleaseCatalog(
      input: ReleaseCatalogRequest,
    ): Promise<ReleaseCatalog | null> {
      const scopeKey = releaseCatalogScopeKeyOf(input);
      const row = await db.findOne("release_catalogs", { scope_key: scopeKey });
      return projectReleaseCatalogRow(
        row === null ? null : toCatalogRow(row),
        input,
        scopeKey,
      );
    },

    /** Artifact resolution: one batch read of both bundles and one unique read of their patch. */
    async getArtifactInfo(
      targetBundleId: string,
      currentBundleId: string,
      artifactProtocolVersion: 1,
    ): Promise<ArtifactInfo | null> {
      const { readStorageText } = storage;
      if (
        artifactProtocolVersion !== ARTIFACT_PROTOCOL_VERSION ||
        readStorageText === undefined
      ) {
        return null;
      }
      const withCurrent = currentBundleId !== NIL_UUID;
      const [[target, current], patch] = await Promise.all([
        db.findByKeys(
          "bundles",
          withCurrent
            ? [{ id: targetBundleId }, { id: currentBundleId }]
            : [{ id: targetBundleId }],
        ),
        withCurrent
          ? db.findOne("bundle_patches", {
              bundle_id: targetBundleId,
              base_bundle_id: currentBundleId,
            })
          : null,
      ]);
      if (target === null || target === undefined) return null;
      return resolveManifestArtifacts({
        currentBundle: current ? rowToBundle(toBundleRow(current)) : null,
        readStorageText,
        resolveFileUrl: storage.resolveFileUrl,
        targetBundle: rowToBundle(
          toBundleRow(target),
          patch === null ? [] : [toPatchRow(patch)],
        ),
      });
    },

    /** A bundle, its patches, and how many patches start from it. */
    async getBundle(id: string): Promise<BundleDetail | null> {
      const row = await db.findOne("bundles", { id });
      return row === null ? null : detail(row);
    },

    /** One page of the patches that start from a bundle, by target bundle id. */
    async listPatchesFromBase(
      baseBundleId: string,
      input: KeysetInput,
    ): Promise<BundlePatchRow[]> {
      const page = await db.findMany("bundle_patches", {
        index: "byBase",
        where: { base_bundle_id: baseBundleId },
        order: input.order ?? "asc",
        limit: input.limit,
        ...after(input),
      });
      return page.rows.map(toPatchRow);
    },

    /** One page of bundles with their patches, oldest or newest first, optionally for one platform. */
    async listBundles(
      input: KeysetInput & { readonly platform?: "ios" | "android" },
    ): Promise<BundleDetail[]> {
      const page =
        input.platform === undefined
          ? await db.findMany("bundles", {
              index: "all",
              where: {},
              order: input.order ?? "asc",
              limit: input.limit,
              ...after(input),
            })
          : await db.findMany("bundles", {
              index: "byPlatform",
              where: { platform: input.platform },
              order: input.order ?? "asc",
              limit: input.limit,
              ...after(input),
            });
      return Promise.all(page.rows.map(detail));
    },

    /** Bundles in total or for one platform: one counter row. */
    async countBundles(platform?: "ios" | "android"): Promise<number> {
      const { rows } = await db.findAggregates("bundle_totals", {
        index: "byPlatform",
        where: { platform_key: platform ?? "*" },
        limit: 1,
      });
      return rows[0]?.bundles ?? 0;
    },

    /** Auto-patch bases for a new bundle: the newest older bundles sharing its candidate key. */
    async findBaseBundleIds(
      candidateKey: string,
      bundleId: string,
      limit: number,
    ): Promise<string[]> {
      const { rows } = await db.findAggregates("base_candidates", {
        index: "byKey",
        where: { candidate_key: candidateKey },
        range: { lt: bundleId },
        order: "desc",
        limit,
      });
      return rows.map((row) => row.bundle_id);
    },

    async getRelease(id: string): Promise<ReleaseRow | null> {
      const row = await db.findOne("releases", { id });
      return row === null ? null : toReleaseRow(row);
    },

    /** One page of releases through the index its filter names. */
    async listReleases(
      input: KeysetInput & { readonly filter: ReleaseFilter },
    ): Promise<ReleaseRow[]> {
      const { filter } = input;
      const options = {
        order: input.order ?? "asc",
        limit: input.limit,
        ...after(input),
      } as const;
      const page =
        filter.kind === "all"
          ? await db.findMany("releases", {
              index: "all",
              where: {},
              ...options,
            })
          : filter.kind === "bundle"
            ? await db.findMany("releases", {
                index: "byBundle",
                where: { bundle_id: filter.bundleId },
                ...options,
              })
            : filter.kind === "scope"
              ? filter.enabled === undefined
                ? await db.findMany("releases", {
                    index: "byScope",
                    where: { scope_key: filter.scopeKey },
                    ...options,
                  })
                : await db.findMany("releases", {
                    index: "byScopeEnabled",
                    where: {
                      scope_key: filter.scopeKey,
                      enabled: filter.enabled,
                    },
                    ...options,
                  })
              : filter.enabled === undefined
                ? await db.findMany("releases", {
                    index: "byChannelPlatform",
                    where: {
                      channel_id: filter.channelId,
                      platform: filter.platform,
                    },
                    ...options,
                  })
                : await db.findMany("releases", {
                    index: "byChannelPlatformEnabled",
                    where: {
                      channel_id: filter.channelId,
                      platform: filter.platform,
                      enabled: filter.enabled,
                    },
                    ...options,
                  });
      return page.rows.map(toReleaseRow);
    },

    /** A scope's newest release id: `byScope` descending, limit 1. */
    async latestReleaseId(scopeKey: string): Promise<string | null> {
      const { rows } = await db.findMany("releases", {
        index: "byScope",
        where: { scope_key: scopeKey },
        order: "desc",
        limit: 1,
      });
      return rows[0]?.id ?? null;
    },

    async getReleaseCatalogRow(
      scopeKey: string,
    ): Promise<ReleaseCatalogRow | null> {
      const row = await db.findOne("release_catalogs", { scope_key: scopeKey });
      return row === null ? null : toCatalogRow(row);
    },

    async listReleaseCatalogs(
      input: KeysetInput,
    ): Promise<ReleaseCatalogRow[]> {
      const page = await db.findMany("release_catalogs", {
        index: "all",
        where: {},
        order: input.order ?? "asc",
        limit: input.limit,
        ...after(input),
      });
      return page.rows.map(toCatalogRow);
    },

    /** Every channel, by name. */
    async listChannels(): Promise<ChannelRow[]> {
      const rows = await drain((page) =>
        db.findMany("channels", {
          index: "all",
          where: {},
          limit: PAGE,
          ...page,
        }),
      );
      return rows.map(toChannelRow);
    },

    async findChannelByName(name: string): Promise<ChannelRow | null> {
      const row = await db.findOne("channels", { name });
      return row === null ? null : toChannelRow(row);
    },
  };
};

export type CoreReads = ReturnType<typeof createCoreReads>;
