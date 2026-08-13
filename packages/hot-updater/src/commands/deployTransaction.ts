import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import type {
  BundleRepository,
  LegacyBundle,
  ReleaseCatalogMutationInput,
  ReleaseCatalogMutationResult,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import {
  bundleToPatchRows,
  bundleToRow,
  commitReleaseCatalogMutations,
  createUUIDv7After,
  ReleaseCatalogMutationError,
} from "@hot-updater/plugin-core";

const RELEASE_PAGE_SIZE = 1_000;
const MAX_RELEASE_ID_ATTEMPTS = 3;

export interface DeploymentWrite {
  readonly authorityId: string;
  readonly bundle: LegacyBundle;
}

const findLatestReleaseId = async (
  database: BundleRepository,
  scopeKey: string,
): Promise<string | null> => {
  let latestId: string | null = null;
  for (;;) {
    const page = await database.models.releases.findManyByScope({
      scopeKey,
      ...(latestId === null ? {} : { afterReleaseId: latestId }),
      consistency: "strong",
      limit: RELEASE_PAGE_SIZE,
    });
    if (page.length === 0) return latestId;
    latestId = page.at(-1)!.id;
    if (page.length < RELEASE_PAGE_SIZE) return latestId;
  }
};

const prepareDeploymentMutation = async (
  database: BundleRepository,
  { authorityId, bundle }: DeploymentWrite,
): Promise<ReleaseCatalogMutationInput> => {
  const channelKey = encodeChannelKey(bundle.channel);
  const existingChannel = (
    await database.models.channels.list({})
  ).channels.find(({ name }) => name === bundle.channel);
  const channel =
    existingChannel ??
    (
      await database.models.channels.insert({
        row: { id: `channel:${channelKey}`, name: bundle.channel },
        onConflict: "returnExisting",
      })
    ).row;
  const fingerprintHash = bundle.fingerprintHash;
  const strategy = fingerprintHash === null ? "APP_VERSION" : "FINGERPRINT";
  const scopeKey =
    fingerprintHash === null
      ? createReleaseCatalogScopeKey({
          authorityId,
          channelKey,
          platform: bundle.platform,
          strategy: "APP_VERSION",
        })
      : createReleaseCatalogScopeKey({
          authorityId,
          channelKey,
          fingerprintHash,
          platform: bundle.platform,
          strategy: "FINGERPRINT",
        });
  const latestReleaseId = await findLatestReleaseId(database, scopeKey);
  const floor =
    latestReleaseId === null || bundle.id > latestReleaseId
      ? bundle.id
      : latestReleaseId;
  const now = Date.now();
  const release: ReleaseRow = {
    bundle_id: bundle.id,
    channel_id: channel.id,
    created_at_ms: now,
    enabled: bundle.enabled,
    fingerprint_hash: fingerprintHash,
    id: createUUIDv7After(floor),
    kind: "BUNDLE",
    message: bundle.message,
    operation: "DEPLOY",
    platform: bundle.platform,
    revision: 1,
    rollout_cohort_count: bundle.rolloutCohortCount ?? 1_000,
    scope_key: scopeKey,
    should_force_update: bundle.shouldForceUpdate,
    source_release_id: null,
    strategy,
    target_app_version: bundle.targetAppVersion,
    target_cohorts: bundle.targetCohorts ?? [],
    updated_at_ms: now,
  };

  return {
    companionChanges: [
      {
        model: "bundles",
        operation: "insert",
        row: bundleToRow(bundle),
      },
      ...bundleToPatchRows(bundle).map((row) => ({
        model: "bundlePatches" as const,
        operation: "insert" as const,
        row,
      })),
    ],
    mutation: { operation: "insert", row: release },
    scope: {
      authorityId,
      channelId: channel.id,
      channelName: channel.name,
      fingerprintHash,
      platform: bundle.platform,
      scopeKey,
      strategy,
    },
    updatedAtMs: now,
  };
};

export const commitDeployments = async ({
  database,
  deployments,
}: {
  readonly database: BundleRepository;
  readonly deployments: readonly DeploymentWrite[];
}): Promise<readonly ReleaseCatalogMutationResult[]> => {
  for (let attempt = 1; attempt <= MAX_RELEASE_ID_ATTEMPTS; attempt += 1) {
    const mutations = await Promise.all(
      deployments.map((deployment) =>
        prepareDeploymentMutation(database, deployment),
      ),
    );
    try {
      return await commitReleaseCatalogMutations({
        database,
        maxAttempts: 1,
        mutations,
      });
    } catch (error) {
      if (
        attempt < MAX_RELEASE_ID_ATTEMPTS &&
        error instanceof ReleaseCatalogMutationError &&
        (error.code === "NON_MONOTONIC_RELEASE_ID" ||
          error.code === "VERSION_CONFLICT")
      ) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Unreachable Release deployment state");
};

export const commitDeployment = async (
  input: DeploymentWrite & { readonly database: BundleRepository },
): Promise<ReleaseCatalogMutationResult> => {
  const [result] = await commitDeployments({
    database: input.database,
    deployments: [input],
  });
  return result!;
};

export const prepareAndCommitBundles = async <TResult>({
  database,
  prepare,
}: {
  readonly database: BundleRepository;
  readonly prepare: (
    persistDeployment: (input: DeploymentWrite) => Promise<void>,
  ) => Promise<readonly TResult[]>;
}): Promise<readonly TResult[]> => {
  const prepared: DeploymentWrite[] = [];
  const results = await prepare(async (input) => {
    prepared.push(input);
  });

  // Uploaded content-addressed objects intentionally remain reusable when
  // the database transaction fails; shared assets must not be deleted.
  await commitDeployments({ database, deployments: prepared });

  return results;
};
