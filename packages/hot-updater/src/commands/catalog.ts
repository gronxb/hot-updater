import { loadConfig, p } from "@hot-updater/cli-tools";
import { decodeChannelKey } from "@hot-updater/core";
import {
  preflightReleaseCatalogRebuild,
  rebuildReleaseCatalog,
  type ReleaseCatalogRow,
  type ReleaseCatalogScope,
} from "@hot-updater/plugin-core";

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

const scopeFromCatalog = (catalog: ReleaseCatalogRow): ReleaseCatalogScope => ({
  authorityId: catalog.authority_id,
  channelId: catalog.channel_id,
  channelName: decodeChannelKey(catalog.channel_key),
  fingerprintHash: catalog.fingerprint_hash,
  platform: catalog.platform,
  scopeKey: catalog.scope_key,
  strategy: catalog.strategy,
});

const loadCatalogs = async (
  database: {
    readonly models: {
      readonly releaseCatalogs: {
        findByScopeKey(scopeKey: string): Promise<ReleaseCatalogRow | null>;
        findMany(input: {
          readonly afterScopeKey?: string;
          readonly limit: number;
        }): Promise<readonly ReleaseCatalogRow[]>;
      };
    };
  },
  scopeKeys: readonly string[],
): Promise<readonly ReleaseCatalogRow[]> => {
  if (scopeKeys.length > 0) {
    const catalogs = await Promise.all(
      scopeKeys.map((scopeKey) =>
        database.models.releaseCatalogs.findByScopeKey(scopeKey),
      ),
    );
    const missing = scopeKeys.filter((_, index) => catalogs[index] === null);
    if (missing.length > 0) {
      throw new Error(`Release catalog not found: ${missing.join(", ")}`);
    }
    return catalogs.filter(
      (catalog): catalog is ReleaseCatalogRow => catalog !== null,
    );
  }

  const catalogs: ReleaseCatalogRow[] = [];
  let afterScopeKey: string | undefined;
  for (;;) {
    const page = await database.models.releaseCatalogs.findMany({
      ...(afterScopeKey === undefined ? {} : { afterScopeKey }),
      limit: 1_000,
    });
    catalogs.push(...page);
    if (page.length < 1_000) return catalogs;
    afterScopeKey = page.at(-1)!.scope_key;
  }
};

export const handleCatalogPreflight = async (
  scopeKeys: readonly string[],
  options: CatalogCommandOptions,
) => {
  if (!options.json) printBanner();
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const catalogs = await loadCatalogs(database, scopeKeys);
    const results = await Promise.all(
      catalogs.map(async (catalog) => ({
        scopeKey: catalog.scope_key,
        ...(await preflightReleaseCatalogRebuild({
          database,
          scope: scopeFromCatalog(catalog),
        })),
      })),
    );
    console.log(
      options.json
        ? JSON.stringify(results, null, 2)
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
              state: result.changed ? "rebuild required" : "verified",
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
    const catalogs = await loadCatalogs(database, scopeKeys);
    const preflight = await Promise.all(
      catalogs.map((catalog) =>
        preflightReleaseCatalogRebuild({
          database,
          scope: scopeFromCatalog(catalog),
        }),
      ),
    );
    const changedCount = preflight.filter(({ changed }) => changed).length;
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
      catalogs.map(async (catalog) => ({
        scopeKey: catalog.scope_key,
        ...(await rebuildReleaseCatalog({
          database,
          scope: scopeFromCatalog(catalog),
        })),
      })),
    );
    console.log(
      options.json
        ? JSON.stringify(results, null, 2)
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
              result: result.changed ? "rebuilt" : "verified",
              scope: result.scopeKey,
            })),
          ),
    );
  } finally {
    await safeDispose(database);
  }
};
