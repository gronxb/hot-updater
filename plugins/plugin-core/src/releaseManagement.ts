import {
  createReleaseCatalogScopeKey,
  decodeChannelKey,
  encodeChannelKey,
} from "@hot-updater/core";

import {
  commitReleaseCatalogMutation,
  commitReleaseCatalogMutations,
  preflightReleaseCatalogMutation,
  type ReleaseCatalogMutationInput,
  type ReleaseCatalogMutationPreflight,
  ReleaseCatalogMutationError,
  type ReleaseCatalogMutationResult,
  type ReleaseCatalogScope,
} from "./releaseCatalogMutation";
import type { BundleRepository, ReleaseRow } from "./types";
import { createUUIDv7After } from "./uuidv7";

const RELEASE_PAGE_SIZE = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReleasePolicyPatch {
  readonly enabled?: boolean;
  readonly fingerprintHash?: string;
  readonly message?: string | null;
  readonly rolloutCohortCount?: number;
  readonly shouldForceUpdate?: boolean;
  readonly targetAppVersion?: string;
  readonly targetCohorts?: readonly string[];
}

export interface ReleaseMutationTarget {
  readonly database: BundleRepository;
  readonly expectedRevision?: number;
  readonly releaseId: string;
  readonly updatedAtMs?: number;
}

export class ReleaseManagementError extends Error {
  readonly name = "ReleaseManagementError";

  constructor(
    readonly code:
      | "ENABLED_RELEASE"
      | "RELEASE_NOT_FOUND"
      | "SCOPE_MOVE_UNSUPPORTED"
      | "TARGET_RELEASE_INVALID"
      | "VERSION_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

const readReleaseScope = async (
  database: BundleRepository,
  scopeKey: string,
): Promise<readonly ReleaseRow[]> => {
  const rows: ReleaseRow[] = [];
  let afterReleaseId: string | undefined;
  for (;;) {
    const page = await database.models.releases.findManyByScope({
      scopeKey,
      ...(afterReleaseId === undefined ? {} : { afterReleaseId }),
      consistency: "strong",
      limit: RELEASE_PAGE_SIZE,
    });
    rows.push(...page);
    if (page.length < RELEASE_PAGE_SIZE) return rows;
    const nextCursor = page.at(-1)?.id;
    if (nextCursor === undefined || nextCursor === afterReleaseId) {
      throw new ReleaseCatalogMutationError(
        "INVALID_SCOPE",
        `Release paging did not advance for scope "${scopeKey}".`,
      );
    }
    afterReleaseId = nextCursor;
  }
};

const createForwardReleaseId = (
  rows: readonly ReleaseRow[],
  candidates: readonly (string | null)[],
  nowMs: number,
): string => {
  const floor = [...candidates, rows.at(-1)?.id ?? null]
    .filter((value): value is string =>
      value === null ? false : UUID_PATTERN.test(value),
    )
    .sort()
    .at(-1);
  return createUUIDv7After(floor ?? null, nowMs);
};

const prepareTargetScope = async ({
  authorityId,
  channelName,
  database,
  fingerprintHash,
  platform,
  strategy,
}: {
  readonly authorityId: string;
  readonly channelName: string;
  readonly database: BundleRepository;
  readonly fingerprintHash: string | null;
  readonly platform: "ios" | "android";
  readonly strategy: "APP_VERSION" | "FINGERPRINT";
}): Promise<{
  readonly scope: ReleaseCatalogScope;
}> => {
  const channelKey = encodeChannelKey(channelName);
  const existingChannel = (
    await database.models.channels.list({})
  ).channels.find(({ name }) => name === channelName);
  const channel =
    existingChannel ??
    (
      await database.models.channels.insert({
        row: { id: `channel:${channelKey}`, name: channelName },
        onConflict: "returnExisting",
      })
    ).row;
  const scopeKey =
    strategy === "APP_VERSION"
      ? createReleaseCatalogScopeKey({
          authorityId,
          channelKey,
          platform,
          strategy,
        })
      : createReleaseCatalogScopeKey({
          authorityId,
          channelKey,
          fingerprintHash: fingerprintHash ?? "",
          platform,
          strategy,
        });
  return {
    scope: {
      authorityId,
      channelId: channel.id,
      channelName,
      fingerprintHash,
      platform,
      scopeKey,
      strategy,
    },
  };
};

const loadReleaseTarget = async (
  input: ReleaseMutationTarget,
): Promise<{
  readonly release: ReleaseRow;
  readonly scope: ReleaseCatalogScope;
}> => {
  const release = await input.database.models.releases.findById(
    input.releaseId,
  );
  if (release === null) {
    throw new ReleaseManagementError(
      "RELEASE_NOT_FOUND",
      `Release "${input.releaseId}" was not found.`,
    );
  }
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== release.revision
  ) {
    throw new ReleaseManagementError(
      "VERSION_CONFLICT",
      `Release "${release.id}" is revision ${release.revision}; expected ${input.expectedRevision}.`,
    );
  }
  const catalog = await input.database.models.releaseCatalogs.findByScopeKey(
    release.scope_key,
  );
  if (catalog === null) {
    throw new ReleaseCatalogMutationError(
      "INVALID_SCOPE",
      `Release "${release.id}" has no catalog projection.`,
    );
  }
  return {
    release,
    scope: {
      authorityId: catalog.authority_id,
      channelId: release.channel_id,
      channelName: decodeChannelKey(catalog.channel_key),
      fingerprintHash: release.fingerprint_hash,
      platform: release.platform,
      scopeKey: release.scope_key,
      strategy: release.strategy,
    },
  };
};

const releasePolicyUpdate = (
  release: ReleaseRow,
  patch: ReleasePolicyPatch,
  updatedAtMs: number,
) => {
  if (
    patch.fingerprintHash !== undefined &&
    patch.fingerprintHash !== release.fingerprint_hash
  ) {
    throw new ReleaseManagementError(
      "SCOPE_MOVE_UNSUPPORTED",
      "Changing a fingerprint target requires an atomic Release scope move.",
    );
  }
  return {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.message === undefined ? {} : { message: patch.message }),
    ...(patch.rolloutCohortCount === undefined
      ? {}
      : { rollout_cohort_count: patch.rolloutCohortCount }),
    ...(patch.shouldForceUpdate === undefined
      ? {}
      : { should_force_update: patch.shouldForceUpdate }),
    ...(patch.targetAppVersion === undefined
      ? {}
      : { target_app_version: patch.targetAppVersion }),
    ...(patch.targetCohorts === undefined
      ? {}
      : { target_cohorts: [...patch.targetCohorts] }),
    updated_at_ms: updatedAtMs,
  };
};

export async function updateReleasePolicy(
  input: ReleaseMutationTarget & { readonly patch: ReleasePolicyPatch },
): Promise<ReleaseCatalogMutationResult> {
  const { release, scope } = await loadReleaseTarget(input);
  const updatedAtMs = input.updatedAtMs ?? Date.now();
  return commitReleaseCatalogMutation({
    database: input.database,
    mutation: {
      id: release.id,
      operation: "update",
      update: releasePolicyUpdate(release, input.patch, updatedAtMs),
    },
    scope,
    updatedAtMs,
  });
}

export async function preflightReleasePolicy(
  input: ReleaseMutationTarget & { readonly patch: ReleasePolicyPatch },
): Promise<ReleaseCatalogMutationPreflight> {
  const { release, scope } = await loadReleaseTarget(input);
  const updatedAtMs = input.updatedAtMs ?? Date.now();
  return preflightReleaseCatalogMutation({
    database: input.database,
    mutation: {
      id: release.id,
      operation: "update",
      update: releasePolicyUpdate(release, input.patch, updatedAtMs),
    },
    scope,
    updatedAtMs,
  });
}

export async function deleteRelease(
  input: ReleaseMutationTarget,
): Promise<ReleaseCatalogMutationResult> {
  const { release, scope } = await loadReleaseTarget(input);
  if (release.enabled) {
    throw new ReleaseManagementError(
      "ENABLED_RELEASE",
      `Disable Release "${release.id}" before hard deletion.`,
    );
  }
  return commitReleaseCatalogMutation({
    database: input.database,
    mutation: { id: release.id, operation: "delete" },
    scope,
    updatedAtMs: input.updatedAtMs,
  });
}

export interface PromoteReleaseInput extends ReleaseMutationTarget {
  readonly action?: "copy" | "move";
  readonly targetChannel: string;
}

export interface PromoteReleaseResult {
  readonly source: ReleaseCatalogMutationResult | null;
  readonly target: ReleaseCatalogMutationResult;
}

export async function promoteRelease(
  input: PromoteReleaseInput,
): Promise<PromoteReleaseResult> {
  const { release: source, scope: sourceScope } =
    await loadReleaseTarget(input);
  if (source.kind !== "BUNDLE" || source.bundle_id === null) {
    throw new ReleaseManagementError(
      "TARGET_RELEASE_INVALID",
      "Only a Bundle Release can be promoted.",
    );
  }
  const targetChannel = input.targetChannel.trim();
  if (targetChannel.length === 0) {
    throw new ReleaseManagementError(
      "TARGET_RELEASE_INVALID",
      "Promotion requires a target channel.",
    );
  }
  const { scope: targetScope } = await prepareTargetScope({
    authorityId: sourceScope.authorityId,
    channelName: targetChannel,
    database: input.database,
    fingerprintHash: source.fingerprint_hash,
    platform: source.platform,
    strategy: source.strategy,
  });
  if (targetScope.scopeKey === sourceScope.scopeKey) {
    throw new ReleaseManagementError(
      "TARGET_RELEASE_INVALID",
      "Source and target Release scopes are the same.",
    );
  }
  const targetRows = await readReleaseScope(
    input.database,
    targetScope.scopeKey,
  );
  const updatedAtMs = input.updatedAtMs ?? Date.now();
  const targetRow: ReleaseRow = {
    ...source,
    id: createForwardReleaseId(
      targetRows,
      [source.id, source.bundle_id],
      updatedAtMs,
    ),
    revision: 1,
    scope_key: targetScope.scopeKey,
    channel_id: targetScope.channelId,
    enabled: true,
    rollout_cohort_count: 1_000,
    target_cohorts: [],
    operation: "PROMOTE",
    source_release_id: source.id,
    created_at_ms: updatedAtMs,
    updated_at_ms: updatedAtMs,
  };
  const targetMutation: ReleaseCatalogMutationInput = {
    mutation: { operation: "insert", row: targetRow },
    scope: targetScope,
    updatedAtMs,
  };
  const sourceMutation: ReleaseCatalogMutationInput | null =
    input.action === "move"
      ? {
          mutation: {
            id: source.id,
            operation: "update",
            update: { enabled: false, updated_at_ms: updatedAtMs },
          },
          scope: sourceScope,
          updatedAtMs,
        }
      : null;
  const results = await commitReleaseCatalogMutations({
    database: input.database,
    mutations:
      sourceMutation === null
        ? [targetMutation]
        : [sourceMutation, targetMutation],
  });
  return {
    source: sourceMutation === null ? null : results[0]!,
    target: results.at(-1)!,
  };
}

export interface RollbackReleaseInput extends ReleaseMutationTarget {
  readonly toBundleId?: string | null;
  readonly toReleaseId?: string;
}

const prepareRollbackRelease = async (
  input: RollbackReleaseInput,
): Promise<ReleaseCatalogMutationInput> => {
  const { release: source, scope } = await loadReleaseTarget(input);
  if ((input.toReleaseId === undefined) === (input.toBundleId === undefined)) {
    throw new ReleaseManagementError(
      "TARGET_RELEASE_INVALID",
      "Rollback requires exactly one Release or advanced Bundle target.",
    );
  }
  const target =
    input.toReleaseId === undefined
      ? null
      : await input.database.models.releases.findById(input.toReleaseId);
  if (
    input.toReleaseId !== undefined &&
    (target === null || target.scope_key !== source.scope_key)
  ) {
    throw new ReleaseManagementError(
      "TARGET_RELEASE_INVALID",
      "Rollback target Release must belong to the same scope.",
    );
  }
  const bundleId = target?.bundle_id ?? input.toBundleId ?? null;
  if (bundleId !== null) {
    const bundle = await input.database.models.bundles.findById(bundleId);
    if (bundle === null || bundle.platform !== source.platform) {
      throw new ReleaseManagementError(
        "TARGET_RELEASE_INVALID",
        "Rollback target Bundle was not found for the source platform.",
      );
    }
  }
  const rows = await readReleaseScope(input.database, source.scope_key);
  const updatedAtMs = input.updatedAtMs ?? Date.now();
  const row: ReleaseRow = {
    ...source,
    id: createForwardReleaseId(
      rows,
      [source.id, target?.id ?? null, bundleId],
      updatedAtMs,
    ),
    revision: 1,
    kind: bundleId === null ? "EMBEDDED" : "BUNDLE",
    bundle_id: bundleId,
    enabled: true,
    should_force_update: true,
    rollout_cohort_count: 1_000,
    target_cohorts: [],
    operation: "ROLLBACK",
    source_release_id: target?.id ?? null,
    created_at_ms: updatedAtMs,
    updated_at_ms: updatedAtMs,
  };
  return {
    mutation: { operation: "insert", row },
    scope,
    updatedAtMs,
  };
};

export async function rollbackReleases(input: {
  readonly database: BundleRepository;
  readonly rollbacks: readonly Omit<RollbackReleaseInput, "database">[];
}): Promise<readonly ReleaseCatalogMutationResult[]> {
  const mutations = await Promise.all(
    input.rollbacks.map((rollback) =>
      prepareRollbackRelease({ ...rollback, database: input.database }),
    ),
  );
  return commitReleaseCatalogMutations({ database: input.database, mutations });
}

export async function rollbackRelease(
  input: RollbackReleaseInput,
): Promise<ReleaseCatalogMutationResult> {
  const [result] = await rollbackReleases({
    database: input.database,
    rollbacks: [input],
  });
  return result!;
}
