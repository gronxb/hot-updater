import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";

import { releaseRowToRelease } from "./databaseRows";
import {
  compileReleaseCatalog,
  type ReleaseCatalogCompilation,
} from "./releaseCatalogCompiler";
import type {
  DatabaseChange,
  BundleRepository,
  ReleaseCatalogRow,
  ReleaseRow,
  ReleaseRowUpdate,
} from "./types";

const RELEASE_PAGE_SIZE = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface ReleaseCatalogScope {
  readonly authorityId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly platform: "ios" | "android";
  readonly scopeKey: string;
  readonly strategy: "APP_VERSION" | "FINGERPRINT";
  readonly fingerprintHash: string | null;
}

export type ReleaseCatalogMutation =
  | { readonly operation: "insert"; readonly row: ReleaseRow }
  | {
      readonly operation: "update";
      readonly id: string;
      readonly update: Omit<ReleaseRowUpdate, "revision" | "scope_key">;
    }
  | { readonly operation: "delete"; readonly id: string };

export interface ReleaseCatalogMutationResult {
  readonly attempts: number;
  readonly catalog: ReleaseCatalogRow;
  readonly release: ReleaseRow | null;
}

export class ReleaseCatalogMutationError extends Error {
  readonly name = "ReleaseCatalogMutationError";

  constructor(
    readonly code:
      | "CATALOG_GENERATION_EXHAUSTED"
      | "INVALID_SCOPE"
      | "NON_MONOTONIC_RELEASE_ID"
      | "RELEASE_NOT_FOUND"
      | "VERSION_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

const readScopeReleases = async (
  database: BundleRepository,
  scopeKey: string,
): Promise<ReleaseRow[]> => {
  const releases: ReleaseRow[] = [];
  let afterReleaseId: string | undefined;
  for (;;) {
    const page = await database.models.releases.findManyByScope({
      scopeKey,
      ...(afterReleaseId === undefined ? {} : { afterReleaseId }),
      limit: RELEASE_PAGE_SIZE,
      consistency: "strong",
    });
    for (const row of page) {
      if (row.scope_key !== scopeKey) {
        throw new ReleaseCatalogMutationError(
          "INVALID_SCOPE",
          `Release "${row.id}" was returned for the wrong catalog scope`,
        );
      }
      if (releases.at(-1)?.id === row.id) {
        throw new ReleaseCatalogMutationError(
          "INVALID_SCOPE",
          `Release "${row.id}" was returned more than once`,
        );
      }
      releases.push(row);
    }
    if (page.length < RELEASE_PAGE_SIZE) return releases;
    const next = page.at(-1)?.id;
    if (next === undefined || next === afterReleaseId) {
      throw new ReleaseCatalogMutationError(
        "INVALID_SCOPE",
        "Release scope paging did not advance",
      );
    }
    afterReleaseId = next;
  }
};

const validateScope = (scope: ReleaseCatalogScope): void => {
  const channelKey = encodeChannelKey(scope.channelName);
  if ((scope.strategy === "FINGERPRINT") !== (scope.fingerprintHash !== null)) {
    throw new ReleaseCatalogMutationError(
      "INVALID_SCOPE",
      "Release catalog strategy and fingerprint are inconsistent",
    );
  }
  const expectedScopeKey =
    scope.strategy === "APP_VERSION"
      ? createReleaseCatalogScopeKey({
          authorityId: scope.authorityId,
          channelKey,
          platform: scope.platform,
          strategy: "APP_VERSION",
        })
      : createReleaseCatalogScopeKey({
          authorityId: scope.authorityId,
          channelKey,
          fingerprintHash: scope.fingerprintHash ?? "",
          platform: scope.platform,
          strategy: "FINGERPRINT",
        });
  if (scope.scopeKey !== expectedScopeKey) {
    throw new ReleaseCatalogMutationError(
      "INVALID_SCOPE",
      "Release catalog scope metadata is inconsistent",
    );
  }
};

const applyMutation = (
  rows: readonly ReleaseRow[],
  scope: ReleaseCatalogScope,
  mutation: ReleaseCatalogMutation,
): {
  readonly change: DatabaseChange;
  readonly nextRows: readonly ReleaseRow[];
  readonly release: ReleaseRow | null;
  readonly expectedRevision: number | null;
} => {
  const currentIndex =
    mutation.operation === "insert"
      ? -1
      : rows.findIndex(({ id }) => id === mutation.id);
  const current = currentIndex < 0 ? undefined : rows[currentIndex];

  if (mutation.operation === "insert") {
    const latestId = rows.at(-1)?.id;
    if (
      mutation.row.scope_key !== scope.scopeKey ||
      mutation.row.channel_id !== scope.channelId ||
      mutation.row.platform !== scope.platform ||
      mutation.row.strategy !== scope.strategy ||
      mutation.row.fingerprint_hash !== scope.fingerprintHash ||
      mutation.row.revision !== 1
    ) {
      throw new ReleaseCatalogMutationError(
        "INVALID_SCOPE",
        "Inserted Release does not match its catalog scope",
      );
    }
    if (latestId !== undefined && mutation.row.id <= latestId) {
      throw new ReleaseCatalogMutationError(
        "NON_MONOTONIC_RELEASE_ID",
        `Release "${mutation.row.id}" must sort after "${latestId}"`,
      );
    }
    return {
      change: { model: "releases", operation: "insert", row: mutation.row },
      expectedRevision: null,
      nextRows: [...rows, mutation.row],
      release: mutation.row,
    };
  }

  if (current === undefined) {
    throw new ReleaseCatalogMutationError(
      "RELEASE_NOT_FOUND",
      `Release "${mutation.id}" was not found in scope "${scope.scopeKey}"`,
    );
  }
  if (mutation.operation === "delete") {
    return {
      change: {
        model: "releases",
        operation: "delete",
        where: { id: mutation.id },
      },
      expectedRevision: current.revision,
      nextRows: rows.filter(({ id }) => id !== mutation.id),
      release: null,
    };
  }

  const release: ReleaseRow = {
    ...current,
    ...mutation.update,
    revision: current.revision + 1,
  };
  return {
    change: {
      model: "releases",
      operation: "update",
      where: { id: mutation.id },
      update: {
        ...mutation.update,
        revision: release.revision,
      },
    },
    expectedRevision: current.revision,
    nextRows: rows.map((row) => (row.id === release.id ? release : row)),
    release,
  };
};

export interface ReleaseCatalogMutationInput {
  readonly scope: ReleaseCatalogScope;
  readonly mutation: ReleaseCatalogMutation;
  readonly companionChanges?: readonly DatabaseChange[];
  readonly trailingChanges?: readonly DatabaseChange[];
  readonly updatedAtMs?: number;
}

export interface ReleaseCatalogMutationPreflight {
  readonly catalog: ReleaseCatalogRow;
  readonly currentCatalog: ReleaseCatalogRow | null;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
  readonly expectedReleaseRevision: number | null;
  readonly release: ReleaseRow | null;
}

const prepareReleaseCatalogMutation = async (
  database: BundleRepository,
  mutationInput: ReleaseCatalogMutationInput,
): Promise<{
  readonly applied: ReturnType<typeof applyMutation>;
  readonly catalog: ReleaseCatalogRow;
  readonly compilation: ReleaseCatalogCompilation;
  readonly currentCatalog: ReleaseCatalogRow | null;
  readonly mutationInput: ReleaseCatalogMutationInput;
}> => {
  const [rows, currentCatalog] = await Promise.all([
    readScopeReleases(database, mutationInput.scope.scopeKey),
    database.models.releaseCatalogs.findByScopeKey(
      mutationInput.scope.scopeKey,
    ),
  ]);
  const applied = applyMutation(
    rows,
    mutationInput.scope,
    mutationInput.mutation,
  );
  const compilation = await compileReleaseCatalog({
    strategy: mutationInput.scope.strategy,
    releases: applied.nextRows.map(releaseRowToRelease),
  });
  const generation = (currentCatalog?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new ReleaseCatalogMutationError(
      "CATALOG_GENERATION_EXHAUSTED",
      `Catalog "${mutationInput.scope.scopeKey}" exhausted its generation counter`,
    );
  }
  const catalog: ReleaseCatalogRow = {
    scope_key: mutationInput.scope.scopeKey,
    authority_id: mutationInput.scope.authorityId,
    strategy: mutationInput.scope.strategy,
    channel_id: mutationInput.scope.channelId,
    channel_key: encodeChannelKey(mutationInput.scope.channelName),
    platform: mutationInput.scope.platform,
    fingerprint_hash: mutationInput.scope.fingerprintHash,
    generation,
    payload: compilation.canonicalPayload,
    catalog_hash: compilation.catalogHash,
    byte_size: compilation.byteSize,
    is_tombstone: compilation.payload.releaseDescriptors.length === 0,
    updated_at_ms: mutationInput.updatedAtMs ?? Date.now(),
  };
  return {
    applied,
    catalog,
    compilation,
    currentCatalog,
    mutationInput,
  };
};

export async function preflightReleaseCatalogMutation(
  input: ReleaseCatalogMutationInput & {
    readonly database: BundleRepository;
  },
): Promise<ReleaseCatalogMutationPreflight> {
  validateScope(input.scope);
  const prepared = await prepareReleaseCatalogMutation(input.database, input);
  return {
    catalog: prepared.catalog,
    currentCatalog: prepared.currentCatalog,
    diagnostics: prepared.compilation.diagnostics,
    expectedReleaseRevision: prepared.applied.expectedRevision,
    release: prepared.applied.release,
  };
}

export async function commitReleaseCatalogMutations(input: {
  readonly database: BundleRepository;
  readonly mutations: readonly ReleaseCatalogMutationInput[];
  readonly maxAttempts?: number;
}): Promise<readonly ReleaseCatalogMutationResult[]> {
  if (input.mutations.length === 0) return [];
  const scopeKeys = new Set<string>();
  for (const mutation of input.mutations) {
    validateScope(mutation.scope);
    if (scopeKeys.has(mutation.scope.scopeKey)) {
      throw new ReleaseCatalogMutationError(
        "INVALID_SCOPE",
        `A batch cannot mutate catalog scope "${mutation.scope.scopeKey}" more than once`,
      );
    }
    scopeKeys.add(mutation.scope.scopeKey);
  }
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prepared = await Promise.all(
      input.mutations.map((mutationInput) =>
        prepareReleaseCatalogMutation(input.database, mutationInput),
      ),
    );
    const result = await input.database.commit({
      expectations: prepared.flatMap(
        ({ applied, currentCatalog, mutationInput }) => [
          {
            model: "releases" as const,
            id:
              mutationInput.mutation.operation === "insert"
                ? mutationInput.mutation.row.id
                : mutationInput.mutation.id,
            revision: applied.expectedRevision,
          },
          {
            model: "releaseCatalogs" as const,
            scopeKey: mutationInput.scope.scopeKey,
            generation: currentCatalog?.generation ?? null,
          },
        ],
      ),
      changes: prepared.flatMap(({ applied, catalog, mutationInput }) => [
        ...(mutationInput.companionChanges ?? []),
        applied.change,
        {
          model: "releaseCatalogs" as const,
          operation: "put" as const,
          row: catalog,
        },
        ...(mutationInput.trailingChanges ?? []),
      ]),
    });
    if (result.committed) {
      return prepared.map(({ applied, catalog }) => ({
        attempts: attempt,
        catalog,
        release: applied.release,
      }));
    }
    if (result.conflict.reason !== "version_conflict") {
      throw new ReleaseCatalogMutationError(
        "INVALID_SCOPE",
        `Release mutation failed: ${result.conflict.reason}`,
      );
    }
  }

  throw new ReleaseCatalogMutationError(
    "VERSION_CONFLICT",
    `Release catalog mutation batch conflicted ${maxAttempts} times`,
  );
}

export async function commitReleaseCatalogMutation(
  input: ReleaseCatalogMutationInput & {
    readonly database: BundleRepository;
    readonly maxAttempts?: number;
  },
): Promise<ReleaseCatalogMutationResult> {
  const [result] = await commitReleaseCatalogMutations({
    database: input.database,
    maxAttempts: input.maxAttempts,
    mutations: [input],
  });
  return result!;
}

export interface ReleaseCatalogRebuildResult {
  readonly attempts: number;
  readonly catalog: ReleaseCatalogRow;
  readonly changed: boolean;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
}

export interface ReleaseCatalogRebuildPreflight {
  readonly changed: boolean;
  readonly currentCatalog: ReleaseCatalogRow | null;
  readonly diagnostics: ReleaseCatalogCompilation["diagnostics"];
  readonly projectedCatalog: ReleaseCatalogRow;
}

const catalogProjectionMatches = (
  current: ReleaseCatalogRow,
  scope: ReleaseCatalogScope,
  compilation: ReleaseCatalogCompilation,
): boolean =>
  current.authority_id === scope.authorityId &&
  current.strategy === scope.strategy &&
  current.channel_id === scope.channelId &&
  current.channel_key === encodeChannelKey(scope.channelName) &&
  current.platform === scope.platform &&
  current.fingerprint_hash === scope.fingerprintHash &&
  current.payload === compilation.canonicalPayload &&
  current.catalog_hash === compilation.catalogHash &&
  current.byte_size === compilation.byteSize &&
  current.is_tombstone ===
    (compilation.payload.releaseDescriptors.length === 0);

export async function preflightReleaseCatalogRebuild(input: {
  readonly database: BundleRepository;
  readonly scope: ReleaseCatalogScope;
  readonly updatedAtMs?: number;
}): Promise<ReleaseCatalogRebuildPreflight> {
  validateScope(input.scope);
  const [rows, currentCatalog] = await Promise.all([
    readScopeReleases(input.database, input.scope.scopeKey),
    input.database.models.releaseCatalogs.findByScopeKey(input.scope.scopeKey),
  ]);
  const compilation = await compileReleaseCatalog({
    releases: rows.map(releaseRowToRelease),
    strategy: input.scope.strategy,
  });
  const changed =
    currentCatalog === null ||
    !catalogProjectionMatches(currentCatalog, input.scope, compilation);
  const generation = changed
    ? (currentCatalog?.generation ?? 0) + 1
    : currentCatalog.generation;
  if (!Number.isSafeInteger(generation)) {
    throw new ReleaseCatalogMutationError(
      "CATALOG_GENERATION_EXHAUSTED",
      `Catalog "${input.scope.scopeKey}" exhausted its generation counter`,
    );
  }
  return {
    changed,
    currentCatalog,
    diagnostics: compilation.diagnostics,
    projectedCatalog: {
      authority_id: input.scope.authorityId,
      byte_size: compilation.byteSize,
      catalog_hash: compilation.catalogHash,
      channel_id: input.scope.channelId,
      channel_key: encodeChannelKey(input.scope.channelName),
      fingerprint_hash: input.scope.fingerprintHash,
      generation,
      is_tombstone: compilation.payload.releaseDescriptors.length === 0,
      payload: compilation.canonicalPayload,
      platform: input.scope.platform,
      scope_key: input.scope.scopeKey,
      strategy: input.scope.strategy,
      updated_at_ms:
        changed || currentCatalog === null
          ? (input.updatedAtMs ?? Date.now())
          : currentCatalog.updated_at_ms,
    },
  };
}

export async function rebuildReleaseCatalog(input: {
  readonly database: BundleRepository;
  readonly maxAttempts?: number;
  readonly scope: ReleaseCatalogScope;
  readonly updatedAtMs?: number;
}): Promise<ReleaseCatalogRebuildResult> {
  validateScope(input.scope);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const [rows, currentCatalog] = await Promise.all([
      readScopeReleases(input.database, input.scope.scopeKey),
      input.database.models.releaseCatalogs.findByScopeKey(
        input.scope.scopeKey,
      ),
    ]);
    const compilation = await compileReleaseCatalog({
      releases: rows.map(releaseRowToRelease),
      strategy: input.scope.strategy,
    });
    if (
      currentCatalog !== null &&
      catalogProjectionMatches(currentCatalog, input.scope, compilation)
    ) {
      return {
        attempts: attempt,
        catalog: currentCatalog,
        changed: false,
        diagnostics: compilation.diagnostics,
      };
    }
    const generation = (currentCatalog?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new ReleaseCatalogMutationError(
        "CATALOG_GENERATION_EXHAUSTED",
        `Catalog "${input.scope.scopeKey}" exhausted its generation counter`,
      );
    }
    const catalog: ReleaseCatalogRow = {
      authority_id: input.scope.authorityId,
      byte_size: compilation.byteSize,
      catalog_hash: compilation.catalogHash,
      channel_id: input.scope.channelId,
      channel_key: encodeChannelKey(input.scope.channelName),
      fingerprint_hash: input.scope.fingerprintHash,
      generation,
      is_tombstone: compilation.payload.releaseDescriptors.length === 0,
      payload: compilation.canonicalPayload,
      platform: input.scope.platform,
      scope_key: input.scope.scopeKey,
      strategy: input.scope.strategy,
      updated_at_ms: input.updatedAtMs ?? Date.now(),
    };
    const result = await input.database.commit({
      changes: [{ model: "releaseCatalogs", operation: "put", row: catalog }],
      expectations: [
        {
          generation: currentCatalog?.generation ?? null,
          model: "releaseCatalogs",
          scopeKey: input.scope.scopeKey,
        },
      ],
    });
    if (result.committed) {
      return {
        attempts: attempt,
        catalog,
        changed: true,
        diagnostics: compilation.diagnostics,
      };
    }
    if (result.conflict.reason !== "version_conflict") {
      throw new ReleaseCatalogMutationError(
        "INVALID_SCOPE",
        `Release catalog rebuild failed: ${result.conflict.reason}`,
      );
    }
  }

  throw new ReleaseCatalogMutationError(
    "VERSION_CONFLICT",
    `Release catalog rebuild conflicted ${maxAttempts} times`,
  );
}
