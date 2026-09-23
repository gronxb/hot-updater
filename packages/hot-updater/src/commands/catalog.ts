import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  HotUpdaterCoreApi,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import { createDatabaseCoreApi } from "@hot-updater/server/db";

import { ui } from "../utils/cli-ui";
import { printBanner } from "../utils/printBanner";

export interface CatalogCommandOptions {
  readonly json?: boolean;
  readonly yes?: boolean;
}

const safeDispose = async (database: {
  readonly dispose?: () => Promise<void>;
}) => {
  try {
    await database.dispose?.();
  } catch (error) {
    p.log.warn(
      `Database cleanup failed: ${(error as Error)?.message ?? String(error)}`,
    );
  }
};

const PAGE_SIZE = 500;

/** The requested scopes, each with a catalog, or every catalog's scope, by key. */
const catalogScopeKeys = async (
  core: HotUpdaterCoreApi,
  requestedScopeKeys: readonly string[],
): Promise<readonly string[]> => {
  const requested = [...new Set(requestedScopeKeys)];
  if (requested.length > 0) {
    const catalogs = await Promise.all(
      requested.map((scopeKey) => core.getReleaseCatalogRow(scopeKey)),
    );
    const missing = requested.filter((_, index) => catalogs[index] === null);
    if (missing.length > 0) {
      throw new Error(`Release catalog scope not found: ${missing.join(", ")}`);
    }
    return requested;
  }
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

const projectionState = (result: {
  readonly changed: boolean;
  readonly currentCatalog: ReleaseCatalogRow | null;
}): "missing" | "rebuild required" | "verified" =>
  result.currentCatalog === null
    ? "missing"
    : result.changed
      ? "rebuild required"
      : "verified";

export const handleCatalogPreflight = async (
  scopeKeys: readonly string[],
  options: CatalogCommandOptions,
) => {
  if (!options.json) printBanner();
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const core = createDatabaseCoreApi(database);
    const scopes = await catalogScopeKeys(core, scopeKeys);
    const results = await Promise.all(
      scopes.map(async (scopeKey) => {
        const result = await core.preflightReleaseCatalogRebuild(scopeKey);
        return { scopeKey, state: projectionState(result), ...result };
      }),
    );
    console.log(
      options.json
        ? JSON.stringify(
            results,
            (key, value) => (key === "catalog_id" ? undefined : value),
            2,
          )
        : ui.table(
            [
              { key: "scope", label: "Scope" },
              { key: "generation", label: "Generation" },
              { key: "bytes", label: "Bytes" },
              { key: "descriptors", label: "Descriptors" },
              { key: "segments", label: "Segments" },
              { key: "state", label: "Projection" },
            ],
            results.map((result) => ({
              bytes: String(result.diagnostics.byteSize),
              descriptors: String(result.diagnostics.descriptorCount),
              generation: String(result.projectedCatalog.generation),
              scope: result.scopeKey,
              segments: String(result.diagnostics.segmentCount),
              state: result.state,
            })),
          ),
    );
  } finally {
    await safeDispose(database);
  }
};

export const handleCatalogRebuild = async (
  scopeKeys: readonly string[],
  options: CatalogCommandOptions,
) => {
  if (!options.json) printBanner();
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const core = createDatabaseCoreApi(database);
    const scopes = await catalogScopeKeys(core, scopeKeys);
    const preflight = await Promise.all(
      scopes.map(async (scopeKey) => ({
        scopeKey,
        result: await core.preflightReleaseCatalogRebuild(scopeKey),
      })),
    );
    const changedCount = preflight.filter(
      ({ result }) => result.changed,
    ).length;
    if (!options.yes && changedCount > 0) {
      if (!process.stdin.isTTY) {
        p.log.error("Catalog rebuild requires -y in a non-interactive shell.");
        process.exit(1);
      }
      const confirmed = await p.confirm({
        initialValue: false,
        message: `Rebuild ${changedCount} catalog projection${changedCount === 1 ? "" : "s"}?`,
      });
      if (p.isCancel(confirmed) || !confirmed) process.exit(2);
    }
    const results = await Promise.all(
      preflight.map(async ({ result: previous, scopeKey }) => ({
        previousState: projectionState(previous),
        scopeKey,
        ...(await core.rebuildReleaseCatalog(scopeKey)),
      })),
    );
    console.log(
      options.json
        ? JSON.stringify(
            results,
            (key, value) => (key === "catalog_id" ? undefined : value),
            2,
          )
        : ui.table(
            [
              { key: "scope", label: "Scope" },
              { key: "generation", label: "Generation" },
              { key: "hash", label: "Catalog Hash" },
              { key: "result", label: "Result" },
            ],
            results.map((result) => ({
              generation: String(result.catalog.generation),
              hash: result.catalog.catalog_hash,
              result:
                result.previousState === "missing" && result.changed
                  ? "created"
                  : result.changed
                    ? "rebuilt"
                    : "verified",
              scope: result.scopeKey,
            })),
          ),
    );
  } finally {
    await safeDispose(database);
  }
};
