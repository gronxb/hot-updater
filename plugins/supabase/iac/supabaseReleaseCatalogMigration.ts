import {
  compileLegacyReleaseCatalogBackfill,
  createReleaseCatalogBackfillInsertSql,
  type LegacyBundlePolicyRow,
} from "@hot-updater/server";

export const RELEASE_CATALOG_BACKFILL_START =
  "-- hot-updater:release-catalog-backfill-start";
export const RELEASE_CATALOG_BACKFILL_END =
  "-- hot-updater:release-catalog-backfill-end";

export const materializeReleaseCatalogMigration = async ({
  authorityId,
  legacyBundles,
  migrationSql,
}: {
  readonly authorityId: string;
  readonly legacyBundles: readonly LegacyBundlePolicyRow[];
  readonly migrationSql: string;
}): Promise<string> => {
  const start = migrationSql.indexOf(RELEASE_CATALOG_BACKFILL_START);
  const end = migrationSql.indexOf(RELEASE_CATALOG_BACKFILL_END);
  if (start < 0 || end < start) {
    throw new Error("Supabase Release Catalog migration marker is missing.");
  }

  const backfill = await compileLegacyReleaseCatalogBackfill({
    authorityId,
    rows: legacyBundles,
  });
  const statements = createReleaseCatalogBackfillInsertSql({
    backfill,
    provider: "postgresql",
  });
  const replacement = [
    RELEASE_CATALOG_BACKFILL_START,
    ...(statements.length === 0
      ? ["-- No legacy Bundle policy rows require backfill."]
      : statements.map((statement) => `${statement};`)),
    RELEASE_CATALOG_BACKFILL_END,
  ].join("\n\n");

  return `${migrationSql.slice(0, start)}${replacement}${migrationSql.slice(
    end + RELEASE_CATALOG_BACKFILL_END.length,
  )}`;
};
