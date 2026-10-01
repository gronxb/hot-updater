import type {
  HotUpdaterCoreApi,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";

import type {
  ArtifactStatus,
  ReleaseCatalogIssue,
  ReleaseCatalogStatus,
} from "./issues";

// The admin API serves up to 500 releases or catalogs, and 100 bundles, a page.
const RELEASE_PAGE = 500;
const BUNDLE_PAGE = 100;

const DOCTOR_FIX = "npx hot-updater doctor --fix";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unreachable =
  "Check that server in hot-updater.config.ts loads and its database is reachable from here, then rerun doctor.";

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
      fixability: "blocked",
    },
  ],
});

const artifactsUnchecked = (error: unknown): ArtifactStatus => ({
  unreferenced: [],
  issues: [
    {
      type: "warning",
      code: "ARTIFACTS_UNCHECKED",
      message: `Could not check the artifact records: ${errorMessage(error)}`,
      resolution: unreachable,
      fixability: "blocked",
    },
  ],
});

/** Every artifact record's ID. */
const listArtifactIds = async (core: HotUpdaterCoreApi): Promise<string[]> => {
  const ids: string[] = [];
  for (let after: string | undefined; ; ) {
    const page = await core.listBundles({
      limit: BUNDLE_PAGE,
      order: "asc",
      ...(after === undefined ? {} : { after }),
    });
    ids.push(...page.map(({ bundle }) => bundle.id));
    if (page.length < BUNDLE_PAGE) return ids;
    after = page.at(-1)!.bundle.id;
  }
};

/** Every release's scope, and every artifact a release uses. */
const scanReleases = async (core: HotUpdaterCoreApi) => {
  const scopeKeys = new Set<string>();
  const bundleIds = new Set<string>();
  for (let after: string | undefined; ; ) {
    const page = await core.listReleases({
      filter: { kind: "all" },
      limit: RELEASE_PAGE,
      order: "asc",
      ...(after === undefined ? {} : { after }),
    });
    for (const release of page) {
      scopeKeys.add(release.scope_key);
      if (release.bundle_id !== null) bundleIds.add(release.bundle_id);
    }
    if (page.length < RELEASE_PAGE) return { scopeKeys, bundleIds };
    after = page.at(-1)!.id;
  }
};

/** Every scope with a catalog row, by key. */
const listCatalogScopeKeys = async (
  core: HotUpdaterCoreApi,
): Promise<string[]> => {
  const scopeKeys: string[] = [];
  for (let after: string | undefined; ; ) {
    const page: ReleaseCatalogRow[] = await core.listReleaseCatalogs({
      limit: RELEASE_PAGE,
      order: "asc",
      ...(after === undefined ? {} : { after }),
    });
    scopeKeys.push(...page.map(({ scope_key }) => scope_key));
    if (page.length < RELEASE_PAGE) return scopeKeys;
    after = page.at(-1)!.scope_key;
  }
};

/**
 * Compares each scope's catalog with a rebuild from its releases, without
 * writing: the scopes with a catalog row, and the scopes whose releases have
 * none, which devices get 404 for. A scope core cannot compile is reported
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
                "Restore the scope's catalog row from a backup. doctor --fix does not create one: a new catalog identity would not match the history devices already hold.",
              fixability: "blocked",
            }
          : {
              type: "error",
              code: "RELEASE_CATALOG_CHECK_FAILED",
              scopeKey,
              message: `Could not compile the release catalog of ${scopeKey}: ${errorMessage(failure)}`,
              resolution:
                "Check the scope's releases and the server's logs, then rerun doctor.",
              fixability: "blocked",
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
        message: `The release catalog of ${scopeKey} differs from its releases.`,
        resolution: `Run \`${DOCTOR_FIX}\` to rebuild it from its releases.`,
        fixability: "command",
        commands: [DOCTOR_FIX],
      };
      status.issues.push(issue);
    }
  }
  return status;
};

/**
 * The server's release catalogs, each against a rebuild from its releases,
 * and its artifact records against the releases that use them. Bundles are
 * listed before releases, so a deploy that lands between the two reads adds
 * a release for no artifact this check already holds.
 */
export const checkServerData = async (
  core: HotUpdaterCoreApi,
): Promise<{
  releaseCatalogs: ReleaseCatalogStatus;
  artifacts: ArtifactStatus;
}> => {
  let artifactIds: string[] | Error;
  try {
    artifactIds = await listArtifactIds(core);
  } catch (error) {
    artifactIds = error instanceof Error ? error : new Error(String(error));
  }
  let releases: Awaited<ReturnType<typeof scanReleases>>;
  try {
    releases = await scanReleases(core);
  } catch (error) {
    return {
      releaseCatalogs: releaseCatalogsUnchecked(error),
      artifacts: artifactsUnchecked(error),
    };
  }
  const releaseCatalogs = await checkReleaseCatalogs(core, releases.scopeKeys);
  if (artifactIds instanceof Error) {
    return { releaseCatalogs, artifacts: artifactsUnchecked(artifactIds) };
  }
  const unreferenced = artifactIds.filter((id) => !releases.bundleIds.has(id));
  return {
    releaseCatalogs,
    artifacts: {
      unreferenced,
      issues:
        unreferenced.length === 0
          ? []
          : [
              {
                type: "warning",
                code: "UNREFERENCED_ARTIFACTS",
                artifactIds: unreferenced,
                message: `${unreferenced.length} artifact record${unreferenced.length === 1 ? " has" : "s have"} no release, so storage prune keeps their files.`,
                resolution: `Run \`${DOCTOR_FIX}\` to delete them, then \`npx hot-updater storage prune\` to reclaim their files.`,
                fixability: "command",
                commands: [DOCTOR_FIX],
              },
            ],
    },
  };
};

/**
 * Rebuilds each scope's catalog from its releases: what `doctor --fix`
 * writes for RELEASE_CATALOG_STALE. Returns the catalogs it wrote.
 */
export const rebuildReleaseCatalogs = async (
  core: HotUpdaterCoreApi,
  scopeKeys: readonly string[],
): Promise<string[]> => {
  const wrote: string[] = [];
  for (const scopeKey of scopeKeys) {
    const { catalog, changed } = await core.rebuildReleaseCatalog(scopeKey);
    if (changed) {
      wrote.push(
        `release catalog ${scopeKey}, generation ${catalog.generation}`,
      );
    }
  }
  return wrote;
};

/**
 * Deletes artifact records no release uses, with the patches from and to
 * them: what `doctor --fix` deletes for UNREFERENCED_ARTIFACTS. Core refuses
 * the batch if a release took one up since the check. Their stored files
 * stay until `storage prune`.
 */
export const deleteUnreferencedArtifacts = async (
  core: HotUpdaterCoreApi,
  artifactIds: readonly string[],
): Promise<string[]> => {
  await core.deleteBundles(artifactIds);
  return artifactIds.map((id) => `artifact record ${id}`);
};
