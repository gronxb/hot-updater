import { loadConfig, p } from "@hot-updater/cli-tools";
import {
  type BundleRepository,
  deleteRelease,
  preflightReleasePolicy,
  type ReleasePolicyPatch,
  type ReleaseRow,
  updateReleasePolicy,
} from "@hot-updater/plugin-core";

import { ui } from "../utils/cli-ui";
import { printBanner } from "../utils/printBanner";

const DEFAULT_LIMIT = 20;
const RELEASE_PAGE_SIZE = 1_000;

export interface ReleaseListOptions {
  readonly bundleId?: string;
  readonly channel?: string;
  readonly json?: boolean;
  readonly limit?: number;
  readonly platform?: "ios" | "android";
  readonly targetAppVersion?: string;
}

export interface ReleaseUpdateOptions {
  readonly clearMessage?: boolean;
  readonly clearTargetCohorts?: boolean;
  readonly expectedRevision?: number;
  readonly forceUpdate?: boolean;
  readonly json?: boolean;
  readonly message?: string;
  readonly rolloutCohortCount?: number;
  readonly targetAppVersion?: string;
  readonly targetCohorts?: string;
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

const parseTargetCohorts = (
  value: string | undefined,
): readonly string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((cohort) => cohort.trim())
        .filter(Boolean);

const releaseTarget = (release: ReleaseRow): string =>
  release.strategy === "APP_VERSION"
    ? (release.target_app_version ?? "")
    : (release.fingerprint_hash ?? "");

const releaseTable = (
  releases: readonly ReleaseRow[],
  channels: ReadonlyMap<string, string>,
): string =>
  ui.table(
    [
      { key: "release", label: "ID", format: ui.id },
      { key: "channel", label: "Channel", format: ui.channel },
      { key: "platform", label: "Platform", format: ui.platform },
      { key: "target", label: "Target", format: ui.version },
      { key: "enabled", label: "Enabled" },
      { key: "force", label: "Force" },
      { key: "rollout", label: "Rollout" },
      { key: "message", label: "Message" },
      { key: "created", label: "Created" },
    ],
    releases.map((release) => ({
      channel: channels.get(release.channel_id) ?? release.channel_id,
      created: new Date(release.created_at_ms).toISOString(),
      enabled: release.enabled ? "yes" : "no",
      force: release.should_force_update ? "yes" : "no",
      message: release.message ?? "",
      platform: release.platform,
      release: release.id,
      rollout: `${release.rollout_cohort_count / 10}%`,
      target: releaseTarget(release),
    })),
  );

const releaseSummary = (release: ReleaseRow, channelName: string): string =>
  ui.block("Bundle", [
    ui.kv("ID", ui.id(release.id)),
    ui.kv("Revision", String(release.revision)),
    ui.kv("Channel", ui.channel(channelName)),
    ui.kv("Platform", ui.platform(release.platform)),
    ui.kv("Target", ui.version(releaseTarget(release))),
    ui.kv("Enabled", ui.status(release.enabled)),
    ui.kv("Force update", release.should_force_update ? "yes" : "no"),
    ui.kv("Rollout", `${release.rollout_cohort_count / 10}%`),
    ui.kv(
      "Target cohorts",
      release.target_cohorts.length === 0
        ? ui.muted("(none)")
        : release.target_cohorts.join(", "),
    ),
    release.message === null ? "" : ui.kv("Message", release.message),
    ui.kv("Created", new Date(release.created_at_ms).toISOString()),
    ui.kv("Updated", new Date(release.updated_at_ms).toISOString()),
  ]);

const readScopeReleases = async (
  database: BundleRepository,
  scopeKey: string,
): Promise<readonly ReleaseRow[]> => {
  const releases: ReleaseRow[] = [];
  let afterReleaseId: string | undefined;
  for (;;) {
    const page = await database.models.releases.findManyByScope({
      ...(afterReleaseId === undefined ? {} : { afterReleaseId }),
      consistency: "strong",
      limit: RELEASE_PAGE_SIZE,
      scopeKey,
    });
    releases.push(...page);
    if (page.length < RELEASE_PAGE_SIZE) return releases;
    const nextCursor = page.at(-1)?.id;
    if (nextCursor === undefined || nextCursor === afterReleaseId) {
      throw new Error("Bundle pagination did not advance.");
    }
    afterReleaseId = nextCursor;
  }
};

const releaseDisablePreview = (
  release: ReleaseRow,
  channelName: string,
): string =>
  ui.block("Disable Bundle", [
    ui.kv("ID", ui.id(release.id)),
    ui.kv("Revision", String(release.revision)),
    ui.kv("Channel", ui.channel(channelName)),
    ui.kv("Platform", ui.platform(release.platform)),
    ui.kv("Target", ui.version(releaseTarget(release))),
    ui.kv(
      "Device result",
      "previous compatible enabled bundle or BUILTIN (device-dependent)",
    ),
  ]);

const confirmMutation = async (
  message: string,
  yes: boolean | undefined,
): Promise<void> => {
  if (yes) return;
  if (!process.stdin.isTTY) {
    p.log.error(`${message} Re-run with -y in a non-interactive shell.`);
    process.exit(1);
  }
  const confirmed = await p.confirm({ initialValue: false, message });
  if (p.isCancel(confirmed) || !confirmed) process.exit(2);
};

const channelNames = async (database: {
  readonly models: {
    readonly channels: {
      list(input: {}): Promise<{
        readonly channels: readonly {
          readonly id: string;
          readonly name: string;
        }[];
      }>;
    };
  };
}) =>
  new Map(
    (await database.models.channels.list({})).channels.map((channel) => [
      channel.id,
      channel.name,
    ]),
  );

export const handleReleaseList = async (options: ReleaseListOptions = {}) => {
  if (!options.json) printBanner();
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const channels = await channelNames(database);
    const channelId = options.channel
      ? [...channels].find(([, name]) => name === options.channel)?.[0]
      : undefined;
    if (options.channel && channelId === undefined) {
      p.log.error(`No channel named ${options.channel}.`);
      process.exit(1);
    }
    const releases = await database.models.releases.findMany({
      ...(options.bundleId === undefined ? {} : { bundleId: options.bundleId }),
      ...(channelId === undefined ? {} : { channelId }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.targetAppVersion === undefined
        ? {}
        : { targetAppVersion: options.targetAppVersion }),
      limit: options.limit ?? DEFAULT_LIMIT,
    });
    console.log(
      options.json
        ? JSON.stringify(releases, null, 2)
        : releaseTable(releases, channels),
    );
  } finally {
    await safeDispose(database);
  }
};

export const handleReleaseShow = async (
  releaseId: string,
  options: { readonly json?: boolean } = {},
) => {
  if (!options.json) printBanner();
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const [release, channels] = await Promise.all([
      database.models.releases.findById(releaseId),
      channelNames(database),
    ]);
    if (release === null) {
      p.log.error(`No bundle with ID ${releaseId}.`);
      process.exit(1);
    }
    console.log(
      options.json
        ? JSON.stringify(release, null, 2)
        : releaseSummary(
            release,
            channels.get(release.channel_id) ?? release.channel_id,
          ),
    );
  } finally {
    await safeDispose(database);
  }
};

const createPolicyPatch = (
  options: ReleaseUpdateOptions,
): ReleasePolicyPatch => {
  const targetCohorts = parseTargetCohorts(options.targetCohorts);
  return {
    ...(options.clearMessage
      ? { message: null }
      : options.message === undefined
        ? {}
        : { message: options.message }),
    ...(options.rolloutCohortCount === undefined
      ? {}
      : { rolloutCohortCount: options.rolloutCohortCount }),
    ...(options.forceUpdate === undefined
      ? {}
      : { shouldForceUpdate: options.forceUpdate }),
    ...(options.targetAppVersion === undefined
      ? {}
      : { targetAppVersion: options.targetAppVersion }),
    ...(options.clearTargetCohorts
      ? { targetCohorts: [] }
      : targetCohorts === undefined
        ? {}
        : { targetCohorts }),
  };
};

export const handleReleaseUpdate = async (
  releaseId: string,
  options: ReleaseUpdateOptions,
) => {
  const patch = createPolicyPatch(options);
  if (Object.keys(patch).length === 0) {
    p.log.error("No bundle fields were provided.");
    process.exit(1);
  }
  if (!options.json) printBanner();
  await confirmMutation("Update this bundle?", options.yes);
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const result = await updateReleasePolicy({
      database,
      expectedRevision: options.expectedRevision,
      patch,
      releaseId,
    });
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : ui.block("Bundle updated", [
            ui.kv("ID", ui.id(releaseId)),
            ui.kv("Revision", String(result.release?.revision ?? "")),
          ]),
    );
  } finally {
    await safeDispose(database);
  }
};

export const handleReleaseEnablement = async (
  releaseId: string,
  enabled: boolean,
  options: {
    readonly expectedRevision?: number;
    readonly json?: boolean;
    readonly yes?: boolean;
  },
) => {
  if (!options.json) printBanner();
  const config = await loadConfig(null);
  const database = config.database;
  try {
    let expectedRevision = options.expectedRevision;
    if (!enabled) {
      const release = await database.models.releases.findById(releaseId);
      if (release === null) {
        p.log.error(`No bundle with ID ${releaseId}.`);
        process.exit(1);
      }
      expectedRevision ??= release.revision;

      if (!options.json) {
        const [releases, channels] = await Promise.all([
          readScopeReleases(database, release.scope_key),
          channelNames(database),
        ]);
        p.log.message(
          releaseDisablePreview(
            release,
            channels.get(release.channel_id) ?? release.channel_id,
          ),
        );
        const enabledReleases = releases.filter(
          (candidate) => candidate.enabled,
        );
        if (
          release.enabled &&
          enabledReleases.length === 1 &&
          enabledReleases[0]?.id === release.id
        ) {
          p.log.warn(
            "This is the only enabled bundle for this target. Compatible devices may fall back to BUILTIN.",
          );
        }
      }
    }

    await confirmMutation(
      `${enabled ? "Enable" : "Disable"} this bundle?`,
      options.yes,
    );
    const result = await updateReleasePolicy({
      database,
      expectedRevision,
      patch: { enabled },
      releaseId,
    });
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : ui.block(enabled ? "Bundle enabled" : "Bundle disabled", [
            ui.kv("ID", ui.id(releaseId)),
          ]),
    );
  } finally {
    await safeDispose(database);
  }
};

export const handleReleasePreflight = async (
  releaseId: string,
  options: ReleaseUpdateOptions,
) => {
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const result = await preflightReleasePolicy({
      database,
      expectedRevision: options.expectedRevision,
      patch: createPolicyPatch(options),
      releaseId,
    });
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : ui.block("Bundle update preflight", [
            ui.kv(
              "Current bytes",
              String(result.currentCatalog?.byte_size ?? 0),
            ),
            ui.kv("Projected bytes", String(result.diagnostics.byteSize)),
            ui.kv("Maximum bytes", String(256 * 1024)),
            ui.kv("Descriptors", String(result.diagnostics.descriptorCount)),
            ui.kv("Intervals", String(result.diagnostics.segmentCount)),
            ui.kv(
              "Named cohorts",
              String(result.diagnostics.distinctTargetCohortCount),
            ),
            ui.kv("Next generation", String(result.catalog.generation)),
          ]),
    );
  } finally {
    await safeDispose(database);
  }
};

export const handleReleaseDelete = async (
  releaseId: string,
  options: {
    readonly expectedRevision?: number;
    readonly json?: boolean;
    readonly yes?: boolean;
  },
) => {
  if (!options.json) printBanner();
  await confirmMutation(
    `Permanently delete disabled bundle ${releaseId}?`,
    options.yes,
  );
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const result = await deleteRelease({
      database,
      expectedRevision: options.expectedRevision,
      releaseId,
    });
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : ui.block("Bundle deleted", [ui.kv("ID", ui.id(releaseId))]),
    );
  } finally {
    await safeDispose(database);
  }
};
