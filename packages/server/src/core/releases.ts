import {
  compileReleaseCatalog,
  createUUIDv7,
  createUUIDv7After,
  isUUIDv7,
  releaseRowToRelease,
  ReleaseCatalogMutationError,
  type BundlePatchRow,
  type BundleRow,
  type ReleaseCatalogCompilation,
  type ReleaseCatalogRow,
  type ReleaseCatalogScope,
  type ReleaseRow,
  type ReleaseRowUpdate,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  decodeChannelKey,
  encodeChannelKey,
} from "@hot-updater/protocol";

import { toCatalogRow, toReleaseRow, type CoreDatabase } from "./reads";
import { insertBundle, type CoreTransaction } from "./writes";

const PAGE = 500;

/** One change to one release, applied with its scope's catalog. */
export type ReleaseChange =
  /** `id` is assigned after the scope's latest release unless given. */
  | {
      readonly operation: "insert";
      readonly row: Omit<ReleaseRow, "id"> & { readonly id?: string };
    }
  | {
      readonly operation: "update";
      readonly id: string;
      readonly update: Omit<ReleaseRowUpdate, "revision" | "scope_key">;
    }
  | { readonly operation: "delete"; readonly id: string };

export interface ReleaseChangeInput {
  readonly scope: ReleaseCatalogScope;
  readonly change: ReleaseChange;
  /** A deploy's new bundle and its patches, written first. */
  readonly bundle?: {
    readonly row: BundleRow;
    readonly patches: readonly BundlePatchRow[];
  };
  readonly updatedAtMs: number;
}

export interface ReleaseChangeResult {
  readonly catalog: ReleaseCatalogRow;
  readonly release: ReleaseRow | null;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
}

const fail = (
  code: ConstructorParameters<typeof ReleaseCatalogMutationError>[0],
  message: string,
): never => {
  throw new ReleaseCatalogMutationError(code, message);
};

const checkScope = (scope: ReleaseCatalogScope): void => {
  const channelKey = encodeChannelKey(scope.channelName);
  const expected =
    scope.strategy === "APP_VERSION"
      ? createReleaseCatalogScopeKey({
          channelKey,
          platform: scope.platform,
          strategy: "APP_VERSION",
        })
      : createReleaseCatalogScopeKey({
          channelKey,
          fingerprintHash: scope.fingerprintHash ?? "",
          platform: scope.platform,
          strategy: "FINGERPRINT",
        });
  if (
    (scope.strategy === "FINGERPRINT") !== (scope.fingerprintHash !== null) ||
    scope.scopeKey !== expected
  ) {
    fail("INVALID_SCOPE", "Release catalog scope metadata is inconsistent");
  }
};

/** Every row of a paged read, as release rows. */
const drainReleases = async (
  page: (
    cursor: string | undefined,
  ) => Promise<{ readonly rows: readonly unknown[]; readonly next?: string }>,
): Promise<ReleaseRow[]> => {
  const rows: ReleaseRow[] = [];
  let cursor: string | undefined;
  do {
    const found = await page(cursor);
    rows.push(...found.rows.map((row) => toReleaseRow(row as never)));
    cursor = found.next;
  } while (cursor !== undefined);
  return rows;
};

const enabledIn = (scopeKey: string, cursor: string | undefined) =>
  ({
    index: "byScopeEnabled",
    where: { scope_key: scopeKey, enabled: true },
    limit: PAGE,
    ...(cursor === undefined ? {} : { cursor }),
  }) as const;

/** A scope's enabled releases, all of them, under the catalog's guard. */
const enabledReleases = (
  tx: CoreTransaction,
  scopeKey: string,
): Promise<ReleaseRow[]> =>
  drainReleases((cursor) =>
    tx.findMany("releases", enabledIn(scopeKey, cursor)),
  );

/** The scope's newest release id: `byScope` descending, limit 1. */
const latestReleaseId = async (tx: CoreTransaction, scopeKey: string) => {
  const { rows } = await tx.findMany("releases", {
    index: "byScope",
    where: { scope_key: scopeKey },
    order: "desc",
    limit: 1,
  });
  return rows[0]?.id ?? null;
};

/** The scope's next catalog generation, compiled as `compilation`. */
const nextCatalog = (
  scope: ReleaseCatalogScope,
  stored: { readonly catalog: ReleaseCatalogRow | null },
  compilation: ReleaseCatalogCompilation,
  updatedAtMs: number,
): ReleaseCatalogRow => {
  const generation = (stored.catalog?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) {
    fail(
      "CATALOG_GENERATION_EXHAUSTED",
      `Catalog "${scope.scopeKey}" exhausted its generation counter`,
    );
  }
  return {
    scope_key: scope.scopeKey,
    catalog_id: stored.catalog?.catalog_id ?? createUUIDv7(),
    strategy: scope.strategy,
    channel_id: scope.channelId,
    channel_key: encodeChannelKey(scope.channelName),
    platform: scope.platform,
    fingerprint_hash: scope.fingerprintHash,
    generation,
    payload: compilation.canonicalPayload,
    catalog_hash: compilation.catalogHash,
    byte_size: compilation.byteSize,
    is_tombstone: compilation.payload.releaseDescriptors.length === 0,
    updated_at_ms: updatedAtMs,
  };
};

/** Compiles `enabled` and writes it as the scope's next catalog generation. */
const writeCatalog = async (
  tx: CoreTransaction,
  scope: ReleaseCatalogScope,
  stored: Awaited<ReturnType<typeof readCatalog>>,
  enabled: readonly ReleaseRow[],
  updatedAtMs: number,
) => {
  const compilation = await compileReleaseCatalog({
    strategy: scope.strategy,
    releases: enabled.map(releaseRowToRelease),
  });
  const catalog = nextCatalog(scope, stored, compilation, updatedAtMs);
  const { scope_key: _scopeKey, ...set } = catalog;
  if (stored.row === null) tx.create("release_catalogs", catalog);
  else tx.update("release_catalogs", stored.row, set);
  return { catalog, compilation };
};

/** The scope's catalog row, and its compiled catalog and generation if it has one. */
export const readCatalog = async (tx: CoreTransaction, scopeKey: string) => {
  const row = await tx.findOne("release_catalogs", { scope_key: scopeKey });
  return {
    row,
    generation: row?.generation ?? null,
    catalog: row === null ? null : toCatalogRow(row),
  };
};

/** A scope with releases and no compiled catalog lost its history. */
const assertHistory = (
  stored: Awaited<ReturnType<typeof readCatalog>>,
  hasReleases: boolean,
) => {
  if (stored.catalog === null && hasReleases) {
    fail(
      "CATALOG_IDENTITY_MISSING",
      "Catalog history is missing. Restore its catalog row from backup before rebuilding or deploying.",
    );
  }
};

/** One release change and its scope's next catalog, inside `tx`. */
export const changeRelease = async (
  tx: CoreTransaction,
  { scope, change, bundle, updatedAtMs }: ReleaseChangeInput,
): Promise<ReleaseChangeResult> => {
  checkScope(scope);
  const stored = await readCatalog(tx, scope.scopeKey);
  const enabled = await enabledReleases(tx, scope.scopeKey);
  if (bundle !== undefined) {
    insertBundle(tx, bundle.row);
    for (const patch of bundle.patches) tx.create("bundle_patches", patch);
  }
  let before: ReleaseRow | null = null;
  let release: ReleaseRow | null;
  if (change.operation === "insert") {
    const latest = await latestReleaseId(tx, scope.scopeKey);
    assertHistory(stored, latest !== null);
    const floor = [
      latest,
      bundle && isUUIDv7(bundle.row.id) ? bundle.row.id : null,
    ]
      .filter((id): id is string => id !== null)
      .sort()
      .at(-1);
    const id = change.row.id ?? createUUIDv7After(floor ?? null);
    if (latest !== null && id <= latest) {
      fail(
        "NON_MONOTONIC_RELEASE_ID",
        `Release "${id}" must sort after "${latest}"`,
      );
    }
    release = { ...change.row, id };
    if (
      release.scope_key !== scope.scopeKey ||
      release.channel_id !== scope.channelId ||
      release.platform !== scope.platform ||
      release.strategy !== scope.strategy ||
      release.fingerprint_hash !== scope.fingerprintHash ||
      release.revision !== 1
    ) {
      fail(
        "INVALID_SCOPE",
        "Inserted Release does not match its catalog scope",
      );
    }
    tx.create("releases", release);
  } else {
    const row = await tx.findOne("releases", { id: change.id });
    if (row === null || row.scope_key !== scope.scopeKey) {
      return fail(
        "RELEASE_NOT_FOUND",
        `Release "${change.id}" was not found in scope "${scope.scopeKey}"`,
      );
    }
    assertHistory(stored, true);
    before = toReleaseRow(row);
    if (change.operation === "delete") {
      await tx.delete("releases", row);
      release = null;
    } else {
      const set = { ...change.update, revision: before.revision + 1 };
      tx.update("releases", row, set);
      release = { ...before, ...set };
    }
  }
  const changedId = before?.id ?? release?.id;
  const next = [
    ...enabled.filter(({ id }) => id !== changedId),
    ...(release?.enabled ? [release] : []),
  ].sort((left, right) => (left.id < right.id ? -1 : 1));
  const { catalog, compilation } = await writeCatalog(
    tx,
    scope,
    stored,
    next,
    updatedAtMs,
  );
  return { catalog, release, diagnostics: compilation.diagnostics };
};

/**
 * Release changes rooted at their catalogs: each reads its scope's catalog
 * and enabled releases, applies the change, and writes the next catalog
 * generation, all in one transaction. A concurrent change in a scope bumps
 * its catalog row, so this transaction reruns instead of publishing a stale
 * catalog.
 */
export const changeReleases = (
  db: CoreDatabase,
  inputs: readonly ReleaseChangeInput[],
): Promise<ReleaseChangeResult[]> => {
  const scopes = new Set(inputs.map(({ scope }) => scope.scopeKey));
  if (scopes.size !== inputs.length) {
    fail("INVALID_SCOPE", "A batch cannot change one catalog scope twice");
  }
  return db.transaction(async (tx) => {
    const results: ReleaseChangeResult[] = [];
    for (const input of inputs) results.push(await changeRelease(tx, input));
    return results;
  });
};

/** Whether `current` is what the scope's enabled releases compile to. */
const isCurrent = (
  scope: ReleaseCatalogScope,
  current: ReleaseCatalogRow,
  compilation: ReleaseCatalogCompilation,
) =>
  current.strategy === scope.strategy &&
  current.channel_id === scope.channelId &&
  current.channel_key === encodeChannelKey(scope.channelName) &&
  current.platform === scope.platform &&
  current.fingerprint_hash === scope.fingerprintHash &&
  current.catalog_hash === compilation.catalogHash;

/** The scope a catalog row names. */
export const catalogRowScope = (
  row: Pick<
    ReleaseCatalogRow,
    | "channel_id"
    | "channel_key"
    | "fingerprint_hash"
    | "platform"
    | "scope_key"
    | "strategy"
  >,
): ReleaseCatalogScope => ({
  channelId: row.channel_id,
  channelName: decodeChannelKey(row.channel_key),
  fingerprintHash: row.fingerprint_hash,
  platform: row.platform as "ios" | "android",
  scopeKey: row.scope_key,
  strategy: row.strategy as "APP_VERSION" | "FINGERPRINT",
});

/**
 * What a rebuild of the scope's catalog would write, without writing: one
 * read of the catalog row and one of the scope's enabled releases. It needs
 * no transaction, whose guards would read the catalog again for each read
 * beneath it, nor the scope's newest release, which matters only to a scope
 * without a catalog row; that one is not found.
 */
export const preflightRebuild = async (
  db: CoreDatabase,
  scopeKey: string,
  updatedAtMs: number,
) => {
  const row = await db.findOne("release_catalogs", { scope_key: scopeKey });
  if (row === null) {
    throw new Error(`Release catalog "${scopeKey}" was not found.`);
  }
  const current = toCatalogRow(row);
  const scope = catalogRowScope(current);
  checkScope(scope);
  const enabled = await drainReleases((cursor) =>
    db.findMany("releases", enabledIn(scopeKey, cursor)),
  );
  const compilation = await compileReleaseCatalog({
    strategy: scope.strategy,
    releases: enabled.map(releaseRowToRelease),
  });
  const changed = !isCurrent(scope, current, compilation);
  return {
    changed,
    currentCatalog: current,
    diagnostics: compilation.diagnostics,
    projectedCatalog: changed
      ? nextCatalog(scope, { catalog: current }, compilation, updatedAtMs)
      : current,
  };
};

/** Recompiles a scope's catalog from its enabled releases inside `tx`; an unchanged catalog is not rewritten. */
export const rebuildScope = async (
  tx: CoreTransaction,
  scope: ReleaseCatalogScope,
  updatedAtMs: number,
): Promise<{
  readonly catalog: ReleaseCatalogRow;
  readonly current: ReleaseCatalogRow | null;
  readonly changed: boolean;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
}> => {
  checkScope(scope);
  const stored = await readCatalog(tx, scope.scopeKey);
  assertHistory(stored, (await latestReleaseId(tx, scope.scopeKey)) !== null);
  const enabled = await enabledReleases(tx, scope.scopeKey);
  const compilation = await compileReleaseCatalog({
    strategy: scope.strategy,
    releases: enabled.map(releaseRowToRelease),
  });
  const current = stored.catalog;
  if (current !== null && isCurrent(scope, current, compilation)) {
    return {
      catalog: current,
      current,
      changed: false,
      diagnostics: compilation.diagnostics,
    };
  }
  const written = await writeCatalog(tx, scope, stored, enabled, updatedAtMs);
  return {
    catalog: written.catalog,
    current,
    changed: true,
    diagnostics: written.compilation.diagnostics,
  };
};

/** Recompiles a scope's catalog from its enabled releases; an unchanged catalog is not rewritten. */
export const rebuildCatalog = (
  db: CoreDatabase,
  scope: ReleaseCatalogScope,
  updatedAtMs: number,
): Promise<{
  readonly catalog: ReleaseCatalogRow;
  readonly changed: boolean;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
}> =>
  db.transaction(async (tx) => {
    const { current: _current, ...rebuilt } = await rebuildScope(
      tx,
      scope,
      updatedAtMs,
    );
    return rebuilt;
  });
