import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  decodeChannelKey,
  parseReleaseCatalogScopeKey,
} from "@hot-updater/core";
import {
  preflightReleaseCatalogRebuild,
  rebuildReleaseCatalog,
  type ChannelRow,
  type DatabaseModels,
  type ReleaseCatalogRow,
  type ReleaseCatalogScope,
  type ReleaseRow,
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

const PAGE_SIZE = 1_000;

interface CatalogDatabaseReader {
  readonly models: Pick<
    DatabaseModels,
    "channels" | "releaseCatalogs" | "releases"
  >;
}

const scopeFromCatalog = (catalog: ReleaseCatalogRow): ReleaseCatalogScope => {
  const parsed = parseReleaseCatalogScopeKey(catalog.scope_key);
  return {
    authorityId: parsed.authorityId,
    channelId: catalog.channel_id,
    channelName: decodeChannelKey(parsed.channelKey),
    fingerprintHash:
      parsed.strategy === "FINGERPRINT" ? parsed.fingerprintHash : null,
    platform: parsed.platform,
    scopeKey: catalog.scope_key,
    strategy: parsed.strategy,
  };
};

const scopeFromReleases = (
  scopeKey: string,
  releases: readonly ReleaseRow[],
  channelsById: ReadonlyMap<string, ChannelRow>,
): ReleaseCatalogScope => {
  const parsed = parseReleaseCatalogScopeKey(scopeKey);
  const channelName = decodeChannelKey(parsed.channelKey);
  const expectedFingerprintHash =
    parsed.strategy === "FINGERPRINT" ? parsed.fingerprintHash : null;
  const first = releases[0];
  if (first === undefined) {
    throw new Error(`Release catalog scope has no releases: ${scopeKey}`);
  }

  for (const release of releases) {
    if (
      release.scope_key !== scopeKey ||
      release.channel_id !== first.channel_id ||
      release.platform !== parsed.platform ||
      release.strategy !== parsed.strategy ||
      release.fingerprint_hash !== expectedFingerprintHash
    ) {
      throw new Error(
        `Releases disagree with catalog scope metadata: ${scopeKey}`,
      );
    }
  }

  const channel = channelsById.get(first.channel_id);
  if (channel === undefined) {
    throw new Error(
      `Release catalog scope references an unknown channel: ${scopeKey}`,
    );
  }
  if (channel.name !== channelName) {
    throw new Error(
      `Release channel disagrees with catalog scope key: ${scopeKey}`,
    );
  }

  return {
    authorityId: parsed.authorityId,
    channelId: first.channel_id,
    channelName,
    fingerprintHash: expectedFingerprintHash,
    platform: parsed.platform,
    scopeKey,
    strategy: parsed.strategy,
  };
};

const loadAllCatalogs = async (
  database: CatalogDatabaseReader,
): Promise<readonly ReleaseCatalogRow[]> => {
  const catalogs: ReleaseCatalogRow[] = [];
  let afterScopeKey: string | undefined;
  for (;;) {
    const page = await database.models.releaseCatalogs.findMany({
      ...(afterScopeKey === undefined ? {} : { afterScopeKey }),
      limit: PAGE_SIZE,
    });
    catalogs.push(...page);
    if (page.length < PAGE_SIZE) return catalogs;
    const next = page.at(-1)?.scope_key;
    if (next === undefined || next === afterScopeKey) {
      throw new Error("Release catalog paging did not advance");
    }
    afterScopeKey = next;
  }
};

const loadAllReleases = async (
  database: CatalogDatabaseReader,
): Promise<readonly ReleaseRow[]> => {
  const releases: ReleaseRow[] = [];
  let beforeReleaseId: string | undefined;
  for (;;) {
    const page = await database.models.releases.findMany({
      ...(beforeReleaseId === undefined ? {} : { beforeReleaseId }),
      limit: PAGE_SIZE,
    });
    releases.push(...page);
    if (page.length < PAGE_SIZE) return releases;
    const next = page.at(-1)?.id;
    if (next === undefined || next === beforeReleaseId) {
      throw new Error("Release paging did not advance");
    }
    beforeReleaseId = next;
  }
};

const loadScopeReleases = async (
  database: CatalogDatabaseReader,
  scopeKey: string,
): Promise<readonly ReleaseRow[]> => {
  const releases: ReleaseRow[] = [];
  let afterReleaseId: string | undefined;
  for (;;) {
    const page = await database.models.releases.findManyByScope({
      ...(afterReleaseId === undefined ? {} : { afterReleaseId }),
      consistency: "strong",
      limit: PAGE_SIZE,
      scopeKey,
    });
    releases.push(...page);
    if (page.length < PAGE_SIZE) return releases;
    const next = page.at(-1)?.id;
    if (next === undefined || next === afterReleaseId) {
      throw new Error("Release scope paging did not advance");
    }
    afterReleaseId = next;
  }
};

const groupReleasesByScope = (
  releases: readonly ReleaseRow[],
): ReadonlyMap<string, readonly ReleaseRow[]> => {
  const groups = new Map<string, ReleaseRow[]>();
  for (const release of releases) {
    const group = groups.get(release.scope_key);
    if (group === undefined) groups.set(release.scope_key, [release]);
    else group.push(release);
  }
  return groups;
};

const discoverCatalogScopes = async (
  database: CatalogDatabaseReader,
  requestedScopeKeys: readonly string[],
): Promise<readonly ReleaseCatalogScope[]> => {
  const requested = [...new Set(requestedScopeKeys)];
  const catalogs =
    requested.length === 0
      ? await loadAllCatalogs(database)
      : await Promise.all(
          requested.map((scopeKey) =>
            database.models.releaseCatalogs.findByScopeKey(scopeKey),
          ),
        );
  const catalogsByScope = new Map(
    catalogs
      .filter((catalog): catalog is ReleaseCatalogRow => catalog !== null)
      .map((catalog) => [catalog.scope_key, catalog]),
  );
  const releasesByScope =
    requested.length === 0
      ? groupReleasesByScope(await loadAllReleases(database))
      : new Map(
          await Promise.all(
            requested.map(
              async (scopeKey) =>
                [
                  scopeKey,
                  await loadScopeReleases(database, scopeKey),
                ] as const,
            ),
          ),
        );
  const scopeKeys =
    requested.length > 0
      ? requested
      : [
          ...new Set([...catalogsByScope.keys(), ...releasesByScope.keys()]),
        ].sort();
  const missing = scopeKeys.filter(
    (scopeKey) =>
      !catalogsByScope.has(scopeKey) &&
      (releasesByScope.get(scopeKey)?.length ?? 0) === 0,
  );
  if (missing.length > 0) {
    throw new Error(`Release catalog scope not found: ${missing.join(", ")}`);
  }

  const hasReleases = [...releasesByScope.values()].some(
    (releases) => releases.length > 0,
  );
  const channelsById = new Map(
    hasReleases
      ? (await database.models.channels.list({})).channels.map((channel) => [
          channel.id,
          channel,
        ])
      : [],
  );
  return scopeKeys.map((scopeKey) => {
    const catalog = catalogsByScope.get(scopeKey) ?? null;
    const releases = releasesByScope.get(scopeKey) ?? [];
    if (releases.length > 0) {
      return scopeFromReleases(scopeKey, releases, channelsById);
    }
    if (catalog === null) {
      throw new Error(`Release catalog scope not found: ${scopeKey}`);
    }
    return scopeFromCatalog(catalog);
  });
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
    const scopes = await discoverCatalogScopes(database, scopeKeys);
    const results = await Promise.all(
      scopes.map(async (scope) => {
        const result = await preflightReleaseCatalogRebuild({
          database,
          scope,
        });
        return {
          scopeKey: scope.scopeKey,
          state: projectionState(result),
          ...result,
        };
      }),
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
    const scopes = await discoverCatalogScopes(database, scopeKeys);
    const preflight = await Promise.all(
      scopes.map(async (scope) => ({
        scope,
        result: await preflightReleaseCatalogRebuild({
          database,
          scope,
        }),
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
      preflight.map(async ({ result: previous, scope }) => ({
        previousState: projectionState(previous),
        scopeKey: scope.scopeKey,
        ...(await rebuildReleaseCatalog({
          database,
          scope,
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
