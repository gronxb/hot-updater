import { fitText, loadConfig, p } from "@hot-updater/cli-tools";
import {
  type HotUpdaterCoreApi,
  ReleaseCatalogMutationError,
  type ReleaseFilter,
  ReleaseManagementError,
  type ReleasePolicyPatch,
  type ReleaseRow,
} from "@hot-updater/plugin-core";

import { loadServer } from "@/utils/loadServer";

import { ui } from "../utils/cli-ui";
import { publicBundleMessage } from "../utils/publicBundleError";
import { printBanner } from "../utils/printBanner";
import { canPrompt } from "../utils/prompt";

const DEFAULT_LIMIT = 20;

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
  /** Validates the update and shows the projected catalog without saving. */
  readonly dryRun?: boolean;
  readonly expectedRevision?: number;
  readonly forceUpdate?: boolean;
  readonly json?: boolean;
  readonly message?: string;
  readonly rolloutCohortCount?: number;
  readonly targetAppVersion?: string;
  readonly targetCohorts?: string;
  readonly yes?: boolean;
}

export const safeDispose = async (database: {
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

/** A dry run's result: the catalog the update would compile, against its limit. */
const printUpdatePreview = (
  result: Awaited<ReturnType<HotUpdaterCoreApi["preflightReleasePolicy"]>>,
  options: ReleaseUpdateOptions,
) => {
  console.log(
    options.json
      ? JSON.stringify(result, null, 2)
      : fitText(
          ui.block("Bundle update dry run (not saved)", [
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
        ),
  );
};

export const confirmMutation = async (
  message: string,
  yes: boolean | undefined,
): Promise<void> => {
  if (yes) return;
  if (!canPrompt(message)) process.exit(1);
  const confirmed = await p.confirm({ initialValue: false, message });
  if (p.isCancel(confirmed) || !confirmed) process.exit(2);
};

const RELEASE_NOT_FOUND = "RELEASE_NOT_FOUND";

/**
 * Ends a bundle command core refused, such as for an ID no bundle has, with
 * the reason and no stack: on stdout as JSON under `--json`, with the
 * message on stderr. An artifact ID, which `native-build mark` and
 * `patch -b` print, names no bundle, so a missing ID costs one indexed read
 * for the newest bundle that ships it, only on this path. Anything but a
 * refusal is thrown on.
 */
const failBundleCommand = async (
  core: HotUpdaterCoreApi,
  releaseId: string,
  error: unknown,
  { json, outcome }: { readonly json?: boolean; readonly outcome: string },
): Promise<void> => {
  if (
    !(error instanceof ReleaseManagementError) &&
    !(error instanceof ReleaseCatalogMutationError)
  ) {
    throw error;
  }
  const notFound = error.code === RELEASE_NOT_FOUND;
  const [shipping = null] = notFound
    ? await core
        .listReleases({
          filter: { kind: "bundle", bundleId: releaseId },
          limit: 1,
          order: "desc",
        })
        .catch(() => [])
    : [];
  const message = notFound
    ? [
        `No bundle with ID ${releaseId}.`,
        shipping !== null &&
          `That's an artifact ID. Use bundle ${shipping.id}`,
      ]
        .filter(Boolean)
        .join("\n")
    : publicBundleMessage(error.message);
  if (json) {
    console.log(
      JSON.stringify({
        id: releaseId,
        [outcome]: false,
        reason: notFound ? "not_found" : error.code.toLowerCase(),
        ...(shipping === null ? {} : { releaseId: shipping.id }),
      }),
    );
    console.error(fitText(message));
  } else {
    p.log.error(message);
  }
  process.exitCode = 1;
};

const notFoundError = (releaseId: string) =>
  new ReleaseManagementError(
    RELEASE_NOT_FOUND,
    `Release "${releaseId}" was not found.`,
  );

const channelNames = async (core: HotUpdaterCoreApi) =>
  new Map(
    (await core.listChannels()).map((channel) => [channel.id, channel.name]),
  );

const PAGE = 100;

/**
 * Newest releases first. Each read goes through the index the narrowest
 * filters name: a bundle, a channel with its platforms, or every release.
 * Filters no index serves (a platform alone, a target app version) are
 * checked here while reading pages, until `limit` releases match.
 */
const listReleases = async (
  core: HotUpdaterCoreApi,
  options: ReleaseListOptions,
  channelId: string | undefined,
): Promise<ReleaseRow[]> => {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const matches = (release: ReleaseRow) =>
    (options.platform === undefined || release.platform === options.platform) &&
    (channelId === undefined || release.channel_id === channelId) &&
    (options.targetAppVersion === undefined ||
      release.target_app_version === options.targetAppVersion);
  const filters: ReleaseFilter[] =
    options.bundleId !== undefined
      ? [{ kind: "bundle", bundleId: options.bundleId }]
      : channelId === undefined
        ? [{ kind: "all" }]
        : (options.platform === undefined
            ? (["ios", "android"] as const)
            : [options.platform]
          ).map((platform) => ({
            kind: "channelPlatform" as const,
            channelId,
            platform,
          }));
  const found = await Promise.all(
    filters.map(async (filter) => {
      const rows: ReleaseRow[] = [];
      for (let after: string | undefined; rows.length < limit; ) {
        const page = await core.listReleases({
          filter,
          limit: PAGE,
          order: "desc",
          ...(after === undefined ? {} : { after }),
        });
        rows.push(...page.filter(matches));
        if (page.length < PAGE) break;
        after = page.at(-1)!.id;
      }
      return rows;
    }),
  );
  return found
    .flat()
    .sort((left, right) => (left.id < right.id ? 1 : -1))
    .slice(0, limit);
};

export const handleReleaseList = async (options: ReleaseListOptions = {}) => {
  if (!options.json) printBanner();
  const server = await loadServer(await loadConfig(null));
  try {
    const core = server.core;
    const channels = await channelNames(core);
    const channelId = options.channel
      ? [...channels].find(([, name]) => name === options.channel)?.[0]
      : undefined;
    if (options.channel && channelId === undefined) {
      p.log.error(`No channel named ${options.channel}.`);
      process.exit(1);
    }
    const releases = await listReleases(core, options, channelId);
    console.log(
      options.json
        ? JSON.stringify(releases, null, 2)
        : fitText(releaseTable(releases, channels)),
    );
  } finally {
    await safeDispose(server);
  }
};

export const handleReleaseShow = async (
  releaseId: string,
  options: { readonly json?: boolean } = {},
) => {
  if (!options.json) printBanner();
  const server = await loadServer(await loadConfig(null));
  try {
    const core = server.core;
    const [release, channels] = await Promise.all([
      core.getRelease(releaseId),
      channelNames(core),
    ]);
    if (release === null) {
      p.log.error(`No bundle with ID ${releaseId}.`);
      process.exit(1);
    }
    console.log(
      options.json
        ? JSON.stringify(release, null, 2)
        : fitText(
            releaseSummary(
              release,
              channels.get(release.channel_id) ?? release.channel_id,
            ),
          ),
    );
  } finally {
    await safeDispose(server);
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
  // A dry run saves nothing, so it needs no confirmation.
  if (!options.dryRun)
    await confirmMutation("Update this bundle?", options.yes);
  const server = await loadServer(await loadConfig(null));
  try {
    const core = server.core;
    const target = {
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
      patch,
      releaseId,
    };
    let result: Awaited<ReturnType<typeof core.updateReleasePolicy>>;
    try {
      if (options.dryRun) {
        printUpdatePreview(await core.preflightReleasePolicy(target), options);
        return;
      }
      result = await core.updateReleasePolicy(target);
    } catch (error) {
      return await failBundleCommand(core, releaseId, error, {
        json: options.json,
        outcome: "updated",
      });
    }
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : fitText(
            ui.block("Bundle updated", [
              ui.kv("ID", ui.id(releaseId)),
              ui.kv("Revision", String(result.release?.revision ?? "")),
            ]),
          ),
    );
  } finally {
    await safeDispose(server);
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
  const server = await loadServer(await loadConfig(null));
  try {
    const core = server.core;
    let expectedRevision = options.expectedRevision;
    if (!enabled) {
      const release = await core.getRelease(releaseId);
      if (release === null) {
        return await failBundleCommand(
          core,
          releaseId,
          notFoundError(releaseId),
          { json: options.json, outcome: "updated" },
        );
      }
      expectedRevision ??= release.revision;

      if (!options.json) {
        // The scope's enabled releases through their index: two tell whether this is the only one.
        const [enabledReleases, channels] = await Promise.all([
          core.listReleases({
            filter: {
              kind: "scope",
              scopeKey: release.scope_key,
              enabled: true,
            },
            limit: 2,
          }),
          channelNames(core),
        ]);
        p.log.message(
          releaseDisablePreview(
            release,
            channels.get(release.channel_id) ?? release.channel_id,
          ),
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
    let result: Awaited<ReturnType<typeof core.updateReleasePolicy>>;
    try {
      result = await core.updateReleasePolicy({
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        patch: { enabled },
        releaseId,
      });
    } catch (error) {
      return await failBundleCommand(core, releaseId, error, {
        json: options.json,
        outcome: "updated",
      });
    }
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : fitText(
            ui.block(enabled ? "Bundle enabled" : "Bundle disabled", [
              ui.kv("ID", ui.id(releaseId)),
            ]),
          ),
    );
  } finally {
    await safeDispose(server);
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
  const server = await loadServer(await loadConfig(null));
  try {
    const core = server.core;
    const release = await core.getRelease(releaseId);
    if (release === null) {
      return await failBundleCommand(core, releaseId, notFoundError(releaseId), {
        json: options.json,
        outcome: "deleted",
      });
    }
    // Core deletes the artifact with the last bundle on it.
    const artifactId = release.bundle_id;
    let result: Awaited<ReturnType<typeof core.deleteRelease>>;
    try {
      result = await core.deleteRelease({
        ...(options.expectedRevision === undefined
          ? {}
          : { expectedRevision: options.expectedRevision }),
        releaseId,
      });
    } catch (error) {
      return await failBundleCommand(core, releaseId, error, {
        json: options.json,
        outcome: "deleted",
      });
    }
    const deletedArtifactId =
      artifactId !== null && (await core.getBundle(artifactId)) === null
        ? artifactId
        : null;
    if (options.json) {
      console.log(JSON.stringify({ ...result, deletedArtifactId }, null, 2));
      return;
    }
    console.log(
      fitText(ui.block("Bundle deleted", [ui.kv("ID", ui.id(releaseId))])),
    );
    if (deletedArtifactId !== null) {
      p.log.info(
        "No other bundle used its files, so their artifact record was deleted too. The stored files stay until `hot-updater storage prune` deletes them.",
      );
    }
  } finally {
    await safeDispose(server);
  }
};
