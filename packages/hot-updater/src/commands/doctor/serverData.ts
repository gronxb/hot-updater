import type {
  HotUpdaterCoreApi,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";

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

/** Channels read at once while looking for scopes without a catalog. */
const CHANNEL_BATCH = 10;

/**
 * The scope each channel's platform deployed to last: its newest release,
 * one read of limit 1 per channel and platform, so doctor never reads a
 * scope's release history. A scope that lost its catalog row is found here
 * while it holds that channel and platform's newest release.
 */
const listNewestReleaseScopeKeys = async (
  core: HotUpdaterCoreApi,
): Promise<Set<string>> => {
  const scopeKeys = new Set<string>();
  const channels = await core.listChannels();
  for (let start = 0; start < channels.length; start += CHANNEL_BATCH) {
    const newest = await Promise.all(
      channels.slice(start, start + CHANNEL_BATCH).flatMap(({ id }) =>
        (["ios", "android"] as const).map((platform) =>
          core.listReleases({
            filter: { kind: "channelPlatform", channelId: id, platform },
            limit: 1,
            order: "desc",
          }),
        ),
      ),
    );
    for (const [release] of newest) {
      if (release !== undefined) scopeKeys.add(release.scope_key);
    }
  }
  return scopeKeys;
};

/** Every scope with a catalog row, by key. */
const listCatalogScopeKeys = async (
  core: HotUpdaterCoreApi,
): Promise<string[]> => {
  const scopeKeys: string[] = [];
  for (let after: string | undefined; ; ) {
    const page: ReleaseCatalogRow[] = await core.listReleaseCatalogs({
      limit: CATALOG_PAGE,
      order: "asc",
      ...(after === undefined ? {} : { after }),
    });
    scopeKeys.push(...page.map(({ scope_key }) => scope_key));
    if (page.length < CATALOG_PAGE) return scopeKeys;
    after = page.at(-1)!.scope_key;
  }
};

/**
 * Compares each scope's catalog with a rebuild from its releases, without
 * writing: the scopes with a catalog row, and the newest scope of each
 * channel's platform whose releases have none, which devices get 404 for. A scope core cannot compile is reported
 * by itself, beside what the other scopes found.
 */
const checkReleaseCatalogs = async (
  core: HotUpdaterCoreApi,
  releaseScopeKeys: ReadonlySet<string>,
): Promise<ReleaseCatalogStatus> => {
  let catalogScopeKeys: string[];
  try {
    catalogScopeKeys = await listCatalogScopeKeys(core);
  } catch (error) {
    return releaseCatalogsUnchecked(error);
  }
  const status: ReleaseCatalogStatus = { scopes: [], issues: [] };
  const withRow = new Set(catalogScopeKeys);
  const scopeKeys = [...new Set([...catalogScopeKeys, ...releaseScopeKeys])];
  for (const scopeKey of scopeKeys.sort()) {
    let result:
      | Awaited<ReturnType<HotUpdaterCoreApi["preflightReleaseCatalogRebuild"]>>
      | undefined;
    let failure: unknown;
    // Core resolves a scope through its catalog row, so a scope without
    // one is found here, from its releases.
    if (withRow.has(scopeKey)) {
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

/** The server's release catalogs, each against a rebuild from its releases. */
export const checkServerData = async (
  core: HotUpdaterCoreApi,
): Promise<ReleaseCatalogStatus> => {
  let scopeKeys: Set<string>;
  try {
    scopeKeys = await listNewestReleaseScopeKeys(core);
  } catch (error) {
    return releaseCatalogsUnchecked(error);
  }
  return checkReleaseCatalogs(core, scopeKeys);
};
