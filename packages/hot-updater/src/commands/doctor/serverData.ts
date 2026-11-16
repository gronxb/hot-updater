import type {
  HotUpdaterCoreApi,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";

import { partitionCatalogsCommand } from "@hot-updater/cli-tools";

import type { ReleaseCatalogIssue, ReleaseCatalogStatus } from "./issues";

// The admin API serves up to 500 catalogs a page.
const CATALOG_PAGE = 500;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unreachable =
  "Check that database in hot-updater.config.ts is reachable from here, then rerun doctor.";

/** The status when the catalogs could not be read at all, such as when the server does not load. */
export const releaseCatalogsUnchecked = (
  error: unknown,
): ReleaseCatalogStatus => ({
  scopes: [],
  issues: [
    {
      type: "warning",
      code: "RELEASE_CATALOGS_UNCHECKED",
      message: `Could not check the release catalogs: ${errorMessage(error)}`,
      resolution: unreachable,
    },
  ],
});

// The admin API serves up to 100 scope keys a page, one seek each.
const SCOPE_PAGE = 100;

/**
 * Every scope that has releases, with or without a catalog row: one
 * limit-1 seek per scope, without reading any scope's releases.
 */
const listReleaseScopeKeys = async (
  core: HotUpdaterCoreApi,
): Promise<string[]> => {
  const scopeKeys: string[] = [];
  for (let after: string | undefined; ; ) {
    const page = await core.listReleaseScopeKeys({
      limit: SCOPE_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    scopeKeys.push(...page);
    if (page.length < SCOPE_PAGE) return scopeKeys;
    after = page.at(-1)!;
  }
};

/** Every catalog row's scope, and whether it is a tombstone. */
const listCatalogScopes = async (
  core: HotUpdaterCoreApi,
): Promise<{ scopeKey: string; tombstone: boolean }[]> => {
  const scopes: { scopeKey: string; tombstone: boolean }[] = [];
  for (let after: string | undefined; ; ) {
    const page: ReleaseCatalogRow[] = await core.listReleaseCatalogs({
      limit: CATALOG_PAGE,
      order: "asc",
      ...(after === undefined ? {} : { after }),
    });
    scopes.push(
      ...page.map(({ scope_key, is_tombstone }) => ({
        scopeKey: scope_key,
        tombstone: is_tombstone,
      })),
    );
    if (page.length < CATALOG_PAGE) return scopes;
    after = page.at(-1)!.scope_key;
  }
};

/**
 * Catalogued scopes the walk did not list though they hold releases: a
 * catalog that is not a tombstone has an enabled release, so its scope is
 * in the walk unless the index lacks that release's item: on a key-value
 * store, a server of an earlier release writes releases without it.
 * One limit-1 read for each scope missing from the walk, none otherwise.
 */
const listUnindexedScopeKeys = async (
  core: HotUpdaterCoreApi,
  catalogs: readonly { scopeKey: string; tombstone: boolean }[],
  walked: ReadonlySet<string>,
): Promise<string[]> => {
  const unindexed: string[] = [];
  for (const { scopeKey, tombstone } of catalogs) {
    if (tombstone || walked.has(scopeKey)) continue;
    const [release] = await core.listReleases({
      filter: { kind: "scope", scopeKey },
      limit: 1,
    });
    if (release !== undefined) unindexed.push(scopeKey);
  }
  return unindexed;
};

/**
 * Compares each scope's catalog with a rebuild from its releases, without
 * writing: the scopes with a catalog row, and the scopes found without one
 * whose releases devices get 404 for. A scope core cannot compile is
 * reported by itself, beside what the other scopes found.
 */
const checkReleaseCatalogs = async (
  core: HotUpdaterCoreApi,
  catalogScopeKeys: readonly string[],
  releaseScopeKeys: ReadonlySet<string>,
): Promise<ReleaseCatalogStatus> => {
  const status: ReleaseCatalogStatus = { scopes: [], issues: [] };
  const withRow = new Set(catalogScopeKeys);
  const scopeKeys = [...new Set([...catalogScopeKeys, ...releaseScopeKeys])];
  for (const scopeKey of scopeKeys.sort()) {
    let result:
      | Awaited<ReturnType<HotUpdaterCoreApi["preflightReleaseCatalogRebuild"]>>
      | undefined;
    let failure: unknown;
    // Core resolves a scope through its catalog row, so a scope without
    // one is found here, from its releases. A key-value store keeps an
    // index item a 1.1.x server's delete left behind, so the walk may list
    // a scope whose releases are gone: one limit-1 read confirms it has one.
    if (!withRow.has(scopeKey)) {
      const [release] = await core.listReleases({
        filter: { kind: "scope", scopeKey },
        limit: 1,
      });
      if (release === undefined) continue;
    } else {
      try {
        result = await core.preflightReleaseCatalogRebuild(scopeKey);
      } catch (error) {
        failure = error;
      }
    }
    if (result === undefined) {
      const missing =
        !withRow.has(scopeKey) ||
        // A remote server's core reports a lost catalog with this code.
        (failure as { readonly code?: unknown } | null)?.code ===
          "CATALOG_IDENTITY_MISSING";
      status.scopes.push({
        scopeKey,
        state: missing ? "missing" : "unchecked",
        generation: null,
        byteSize: null,
        descriptorCount: null,
      });
      status.issues.push(
        missing
          ? {
              type: "error",
              code: "RELEASE_CATALOG_IDENTITY_MISSING",
              scopeKey,
              message: `${scopeKey} has releases but no catalog row, so devices get 404 for it.`,
              resolution:
                "Restore the scope's catalog row from a backup. A new catalog identity would not match the history devices already hold, so Hot Updater never creates one for a scope that has releases.",
            }
          : {
              type: "error",
              code: "RELEASE_CATALOG_CHECK_FAILED",
              scopeKey,
              message: `Could not compile the release catalog of ${scopeKey}: ${errorMessage(failure)}`,
              resolution:
                "Check the scope's releases and the server's logs, then rerun doctor.",
            },
      );
      continue;
    }
    const state = result.changed ? "stale" : "verified";
    status.scopes.push({
      scopeKey,
      state,
      generation: result.currentCatalog?.generation ?? null,
      byteSize: result.diagnostics.byteSize,
      descriptorCount: result.diagnostics.descriptorCount,
      ...(result.layout === undefined ? {} : { layout: result.layout }),
      ...(result.currentCatalog === null
        ? {}
        : { strategy: result.currentCatalog.strategy }),
    });
    if (state === "stale") {
      const issue: ReleaseCatalogIssue = {
        type: "error",
        code: "RELEASE_CATALOG_STALE",
        scopeKey,
        message: `The release catalog of ${scopeKey} differs from its releases, and devices read the catalog.`,
        resolution:
          "Every release change in the scope recompiles its catalog from its releases: deploy to it, change a release with `npx hot-updater bundle update`, or enable or disable one. Hot Updater writes a scope's catalog with each of its release changes, so a stale one follows an edit made outside Hot Updater or a partial restore of the database.",
        commands: [
          "npx hot-updater deploy",
          "npx hot-updater bundle update <id>",
        ],
      };
      status.issues.push(issue);
    }
  }
  return status;
};

const migrateTable =
  "Create it with the 1.2.0 migration: `npx hot-updater init --provider <provider> --from-env-file .env.hotupdater` for a deployment init created, or `npx hot-updater db migrate <server file>` for a server of your own.";

/**
 * The partitioning switch beside what the scopes' own rows say. A row of
 * the partitions table proves nothing about a scope, so only a scope's
 * catalog row counts as partitioned. Doctor reports; it never sets the
 * switch.
 */
const checkPartitioning = async (
  core: HotUpdaterCoreApi,
  status: ReleaseCatalogStatus,
  command: string,
): Promise<void> => {
  let read: Awaited<ReturnType<HotUpdaterCoreApi["getReleaseCatalogPartitioning"]>>;
  try {
    read = await core.getReleaseCatalogPartitioning();
  } catch (error) {
    // A server before 1.2.0 has no partitioning: nothing to report.
    if ((error as { readonly status?: unknown } | null)?.status === 404) return;
    status.issues.push({
      type: "warning",
      code: "RELEASE_CATALOG_PARTITIONING_UNCHECKED",
      message: `Could not read whether release catalogs are partitioned: ${errorMessage(error)}`,
      resolution: "Fix what the message names, then rerun doctor.",
    });
    return;
  }
  const appVersion = status.scopes.filter(
    ({ strategy }) => strategy === "APP_VERSION",
  );
  const partitioned = status.scopes.filter(
    ({ layout }) => layout === "partitioned",
  ).length;
  status.partitioning = {
    switch: read.switch,
    table: read.table,
    compactScopes:
      read.switch === "on"
        ? appVersion.filter(({ layout }) => layout === "compact").length
        : 0,
  };
  if (read.table === "missing") {
    status.issues.push(
      read.switch === "on"
        ? {
            type: "error",
            code: "RELEASE_CATALOG_PARTITIONS_MISSING",
            message:
              "Release catalogs are partitioned, but the server can't read release_catalog_partitions, so a deploy to a single-row app-version scope fails.",
            resolution: migrateTable,
          }
        : {
            type: "warning",
            code: "RELEASE_CATALOG_PARTITIONS_MISSING",
            message:
              "The server can't read release_catalog_partitions, so release catalogs can't be partitioned.",
            resolution: migrateTable,
          },
    );
    return;
  }
  if (read.switch === "on") return;
  status.issues.push(
    partitioned > 0
      ? {
          type: "warning",
          code: "RELEASE_CATALOG_PARTITIONING_SWITCH_MISSING",
          message: `${partitioned} scope${partitioned === 1 ? " is" : "s are"} partitioned, but partitioning is off, so other scopes stay single-row, each limited to 256 KB.`,
          resolution: "Turn partitioning on again:",
          commands: [command],
        }
      : {
          type: "warning",
          code: "RELEASE_CATALOG_PARTITIONING_OFF",
          message:
            "Release catalogs are single-row, so each scope is limited to 256 KB.",
          resolution:
            "Once every server runs 1.2.0, partition them. It can't be undone:",
          commands: [command],
        },
  );
};

/**
 * The server's release catalogs, each against a rebuild from its releases,
 * and whether they are partitioned, reported last.
 */
export const checkServerData = async (
  core: HotUpdaterCoreApi,
  options: {
    /**
     * The command that turns partitioning on for this project: bare over
     * standaloneRepository, with the server's URL over its database.
     */
    readonly partitionCommand?: string;
  } = {},
): Promise<ReleaseCatalogStatus> => {
  const status = await checkScopes(core);
  // The catalogs couldn't be read at all: neither can the switch.
  if (status.issues.some(({ code }) => code === "RELEASE_CATALOGS_UNCHECKED")) {
    return status;
  }
  await checkPartitioning(
    core,
    status,
    options.partitionCommand ?? partitionCatalogsCommand(),
  );
  return status;
};

const checkScopes = async (
  core: HotUpdaterCoreApi,
): Promise<ReleaseCatalogStatus> => {
  let catalogs: { scopeKey: string; tombstone: boolean }[];
  try {
    catalogs = await listCatalogScopes(core);
  } catch (error) {
    return releaseCatalogsUnchecked(error);
  }
  const catalogScopeKeys = catalogs.map(({ scopeKey }) => scopeKey);
  let walked: Set<string> | undefined;
  let walkFailure: unknown;
  try {
    walked = new Set(await listReleaseScopeKeys(core));
  } catch (error) {
    walkFailure = error;
  }
  const status = await checkReleaseCatalogs(
    core,
    catalogScopeKeys,
    walked ?? new Set(),
  );

  if (walked === undefined) {
    // A self-hosted server older than this hot-updater has no scope route.
    const older =
      (walkFailure as { readonly status?: unknown } | null)?.status === 404;
    status.issues.push({
      type: "warning",
      code: "RELEASE_SCOPES_UNCHECKED",
      message: older
        ? "The server has no release scope route, so doctor checked only the scopes with a catalog row."
        : `Doctor checked only the scopes with a catalog row: listing the scopes with releases failed: ${errorMessage(walkFailure)}`,
      resolution: older
        ? "Upgrade the server's @hot-updater/server, then rerun doctor."
        : "Fix what the message names, then rerun doctor.",
    });
    return status;
  }
  const unindexed = await listUnindexedScopeKeys(core, catalogs, walked);
  if (unindexed.length > 0) {
    status.issues.push({
      type: "warning",
      code: "RELEASE_SCOPES_UNINDEXED",
      message: `The releases' scope index lacks ${unindexed.length} scope${unindexed.length === 1 ? "" : "s"} that ${unindexed.length === 1 ? "has" : "have"} releases, such as ${unindexed[0]}, so doctor may miss a scope with releases and no catalog row. A server of an earlier release, still running after the migration, writes releases without the index.`,
      resolution:
        "Once every server runs this release, migrate the database again, which writes the missing index items: `npx hot-updater init --provider <provider> --from-env-file .env.hotupdater` for a deployment init created, or `npx hot-updater db migrate <server file>` for a server of your own. Then rerun doctor.",
    });
  }
  return status;
};
