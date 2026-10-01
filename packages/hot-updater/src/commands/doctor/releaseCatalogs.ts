import type { ConfigResponse } from "@hot-updater/cli-tools";
import type {
  HotUpdaterCoreApi,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";

import { loadServer } from "../../utils/loadServer";
import type { ReleaseCatalogIssue, ReleaseCatalogStatus } from "./issues";

const PAGE_SIZE = 500;

const DOCTOR_FIX = "npx hot-updater doctor --fix";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Core on the server hot-updater.config.ts points at: the definition's own,
 * or a remote server's admin API. Returns it with what closes it.
 */
const openCore = async (config: Pick<ConfigResponse, "server">) => {
  const server = await loadServer(config);
  return { core: server.core, dispose: () => server.dispose() };
};

/** Every scope with a catalog, by key. */
const listCatalogScopeKeys = async (
  core: HotUpdaterCoreApi,
): Promise<string[]> => {
  const scopeKeys: string[] = [];
  for (let after: string | undefined; ; ) {
    const page: ReleaseCatalogRow[] = await core.listReleaseCatalogs({
      limit: PAGE_SIZE,
      order: "asc",
      ...(after === undefined ? {} : { after }),
    });
    scopeKeys.push(...page.map(({ scope_key }) => scope_key));
    if (page.length < PAGE_SIZE) return scopeKeys;
    after = page.at(-1)!.scope_key;
  }
};

const unchecked = (reason: string): ReleaseCatalogIssue => ({
  type: "warning",
  code: "RELEASE_CATALOGS_UNCHECKED",
  message: `Could not check the release catalogs: ${reason}`,
  resolution:
    "Check that server in hot-updater.config.ts loads and its database is reachable from here, then rerun doctor.",
  fixability: "blocked",
});

/** The status when the catalogs could not be read at all, such as when the config fails to load. */
export const releaseCatalogsUnchecked = (
  error: unknown,
): ReleaseCatalogStatus => ({
  scopes: [],
  issues: [unchecked(errorMessage(error))],
});

/**
 * Compares each release catalog with a rebuild from its releases, without
 * writing: RELEASE_CATALOG_STALE for each one that differs. A database the
 * CLI cannot reach is a warning, never a failure.
 */
export const checkReleaseCatalogs = async (
  config: Pick<ConfigResponse, "server">,
): Promise<ReleaseCatalogStatus> => {
  let opened: Awaited<ReturnType<typeof openCore>>;
  try {
    opened = await openCore(config);
  } catch (error) {
    return releaseCatalogsUnchecked(error);
  }
  try {
    const status: ReleaseCatalogStatus = { scopes: [], issues: [] };
    for (const scopeKey of await listCatalogScopeKeys(opened.core)) {
      let result: Awaited<
        ReturnType<HotUpdaterCoreApi["preflightReleaseCatalogRebuild"]>
      >;
      try {
        result = await opened.core.preflightReleaseCatalogRebuild(scopeKey);
      } catch (error) {
        // A remote server's core reports the same code over its admin API.
        if (
          (error as { readonly code?: unknown } | null)?.code ===
          "CATALOG_IDENTITY_MISSING"
        ) {
          status.issues.push({
            type: "error",
            code: "RELEASE_CATALOG_IDENTITY_MISSING",
            scopeKey,
            message: `The release catalog of ${scopeKey} has lost its identity: ${errorMessage(error)}`,
            resolution:
              "Restore the scope's catalog row from a backup before rebuilding or deploying; a new identity would not match the devices' history.",
            fixability: "blocked",
          });
          continue;
        }
        throw error;
      }
      const state =
        result.currentCatalog === null
          ? "missing"
          : result.changed
            ? "stale"
            : "verified";
      status.scopes.push({
        scopeKey,
        state,
        generation: result.currentCatalog?.generation ?? null,
        byteSize: result.diagnostics.byteSize,
        descriptorCount: result.diagnostics.descriptorCount,
      });
      if (state !== "verified") {
        status.issues.push({
          type: "error",
          code: "RELEASE_CATALOG_STALE",
          scopeKey,
          message:
            state === "missing"
              ? `The release catalog of ${scopeKey} has no compiled projection.`
              : `The release catalog of ${scopeKey} differs from its releases.`,
          resolution: `Run \`${DOCTOR_FIX}\` to rebuild it from its releases.`,
          fixability: "command",
          commands: [DOCTOR_FIX],
        });
      }
    }
    return status;
  } catch (error) {
    return releaseCatalogsUnchecked(error);
  } finally {
    await opened.dispose().catch(() => undefined);
  }
};

/**
 * Rebuilds each scope's catalog from its releases: what `doctor --fix`
 * writes for RELEASE_CATALOG_STALE. Returns the catalogs it wrote.
 */
export const rebuildReleaseCatalogs = async (
  config: Pick<ConfigResponse, "server">,
  scopeKeys: readonly string[],
): Promise<string[]> => {
  const { core, dispose } = await openCore(config);
  try {
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
  } finally {
    await dispose().catch(() => undefined);
  }
};
