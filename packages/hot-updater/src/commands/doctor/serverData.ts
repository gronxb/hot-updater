import type {
  HotUpdaterCoreApi,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import {
  decodeChannelKey,
  MAX_COMPILED_CATALOG_BYTES,
  parseReleaseCatalogScopeKey,
} from "@hot-updater/protocol";

import type { ReleaseCatalogIssue, ReleaseCatalogStatus } from "./issues";

// The admin API serves up to 500 catalogs a page.
const CATALOG_PAGE = 500;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unreachable =
  "Check that database in hot-updater.config.ts is reachable from here, then rerun doctor.";

/** The share of the size limit at which doctor warns before deploys fail. */
const NEAR_LIMIT = 0.8;

/** A scope's catalog at or past NEAR_LIMIT, named by its channel and platform. */
const nearLimit = (
  scopeKey: string,
  byteSize: number,
): ReleaseCatalogIssue | null => {
  if (byteSize < NEAR_LIMIT * MAX_COMPILED_CATALOG_BYTES) return null;
  const { channelKey, platform } = parseReleaseCatalogScopeKey(scopeKey);
  const percent = Math.floor((byteSize / MAX_COMPILED_CATALOG_BYTES) * 100);
  return {
    type: "warning",
    code: "RELEASE_CATALOG_NEAR_LIMIT",
    scopeKey,
    message: `The ${platform} release catalog of channel "${decodeChannelKey(channelKey)}" is ${percent}% of its ${MAX_COMPILED_CATALOG_BYTES / 1024} KiB limit.`,
    resolution:
      "Disable or delete old bundles on that channel before a deploy to it fails.",
  };
};

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
  repair: string,
): Promise<ReleaseCatalogStatus> => {
  const status: ReleaseCatalogStatus = { scopes: [], issues: [] };
  let withoutLabels = 0;
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
    });
    if (state === "stale" && result.labelsOnly === true) {
      // Compiled before its releases had labels: the label fill rebuilds it.
      withoutLabels += 1;
    } else if (state === "stale") {
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
    const near = nearLimit(scopeKey, result.diagnostics.byteSize);
    if (near !== null) status.issues.push(near);
  }
  if (withoutLabels > 0) {
    status.issues.push({
      type: "warning",
      code: "RELEASE_CATALOGS_WITHOUT_LABELS",
      message: `${withoutLabels} release catalog${withoutLabels === 1 ? " lacks" : "s lack"} the labels of ${withoutLabels === 1 ? "its" : "their"} releases, so apps don't get them.`,
      resolution: "Rebuild them with their labels:",
      commands: [repair],
    });
  }
  return status;
};

/**
 * Releases without a label: written before labels, or by a server of an
 * earlier release after the migration. Two reads per scope and one per
 * channel and platform, then the releases of a channel and platform that
 * has some.
 */
const checkReleaseLabels = async (
  core: HotUpdaterCoreApi,
  repair: string,
  schemaRepair: LabelSchemaRepair | undefined,
): Promise<ReleaseCatalogIssue | null> => {
  let releases: number;
  try {
    ({ releases } = await core.fillReleaseLabels({
      dryRun: true,
      catalogs: false,
    }));
  } catch (error) {
    return {
      type: "warning",
      code: "RELEASE_LABELS_UNCHECKED",
      message: `Could not check release labels: ${errorMessage(error)}`,
      ...(schemaRepair === undefined
        ? { resolution: "Fix what the message names, then rerun doctor." }
        : {
            resolution: schemaRepair.resolution,
            commands: [...schemaRepair.commands],
          }),
    };
  }
  if (releases === 0) return null;
  return {
    type: "warning",
    code: "RELEASE_LABELS_MISSING",
    message: `${releases} release${releases === 1 ? " has" : "s have"} no label.`,
    resolution: "Label them in the order they were created:",
    commands: [repair],
  };
};

/**
 * What adds release labels' schema, when the label check fails on a
 * database that may lack it, such as one a 1.2 prerelease migrated: the
 * check's failure is then the database's, and this its next step.
 */
export interface LabelSchemaRepair {
  readonly resolution: string;
  readonly commands: readonly string[];
}

/**
 * The server's release catalogs, each against a rebuild from its releases,
 * and its releases' labels. `repair` is the command that labels the
 * releases and rebuilds the catalogs that lack them: `db migrate`, which
 * deploys nothing.
 */
export const checkServerData = async (
  core: HotUpdaterCoreApi,
  repair = "npx hot-updater db migrate",
  labelSchemaRepair?: LabelSchemaRepair,
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
    repair,
  );
  const labels = await checkReleaseLabels(core, repair, labelSchemaRepair);
  if (labels !== null) status.issues.push(labels);
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
