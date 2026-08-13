import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  BundleRepository,
  Platform,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { rollbackReleases } from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { PLATFORMS } from "../commandOptions";
import { ui } from "../utils/cli-ui";

const RELEASE_PAGE_SIZE = 1_000;

export interface RollbackOptions {
  readonly embedded?: boolean;
  readonly platform?: Platform;
  readonly toBundle?: string;
  readonly toRelease?: string;
  readonly yes?: boolean;
}

interface RollbackTarget {
  readonly source: ReleaseRow;
  readonly target: ReleaseRow | null;
  readonly toBundleId?: string | null;
}

const safeDispose = async (database: BundleRepository): Promise<void> => {
  try {
    await database.dispose?.();
  } catch (error) {
    p.log.warn(
      `Database cleanup failed: ${(error as Error)?.message ?? String(error)}`,
    );
  }
};

const readChannelReleases = async (
  database: BundleRepository,
  channelId: string,
  platform: Platform,
): Promise<readonly ReleaseRow[]> => {
  const releases: ReleaseRow[] = [];
  let beforeReleaseId: string | undefined;
  for (;;) {
    const page = await database.models.releases.findMany({
      ...(beforeReleaseId === undefined ? {} : { beforeReleaseId }),
      channelId,
      limit: RELEASE_PAGE_SIZE,
      platform,
    });
    releases.push(...page);
    if (page.length < RELEASE_PAGE_SIZE) {
      return releases.sort((left, right) => right.id.localeCompare(left.id));
    }
    const nextCursor = page.at(-1)?.id;
    if (nextCursor === undefined || nextCursor === beforeReleaseId) {
      throw new Error("Release pagination did not advance.");
    }
    beforeReleaseId = nextCursor;
  }
};

const summarizeTarget = (target: RollbackTarget): string =>
  ui.block(ui.platform(target.source.platform), [
    ui.kv("Current Release", ui.id(target.source.id)),
    ui.kv(
      "Target Release",
      target.target === null
        ? ui.muted("advanced target")
        : ui.id(target.target.id),
    ),
    ui.kv(
      "Bundle",
      target.target?.bundle_id ?? target.toBundleId ?? ui.warning("Embedded"),
    ),
    ui.kv("Force update", "yes"),
    ui.kv("Rollout", "100%"),
  ]);

const selectDefaultTarget = (
  releases: readonly ReleaseRow[],
  source: ReleaseRow,
): ReleaseRow | null => {
  const anchorId =
    source.operation === "ROLLBACK" && source.source_release_id !== null
      ? source.source_release_id
      : source.id;
  return (
    releases.find(
      (release) =>
        release.scope_key === source.scope_key && release.id < anchorId,
    ) ?? null
  );
};

export const handleRollback = async (
  channelName: string,
  options: RollbackOptions = {},
) => {
  printBanner();
  if (channelName.trim().length === 0) {
    p.log.error("rollback requires a channel argument: `rollback <channel>`");
    process.exit(1);
  }
  const explicitTargets = [
    options.toRelease !== undefined,
    options.toBundle !== undefined,
    options.embedded === true,
  ].filter(Boolean).length;
  if (explicitTargets > 1) {
    p.log.error("Choose only one of --to-release, --to-bundle, or --embedded.");
    process.exit(1);
  }

  const config = await loadConfig(null);
  const database = config.database;
  try {
    const channel = (await database.models.channels.list({})).channels.find(
      ({ name }) => name === channelName,
    );
    if (channel === undefined) {
      p.log.error(`No channel named ${channelName}.`);
      process.exit(1);
    }

    let explicitRelease: ReleaseRow | null = null;
    if (options.toRelease !== undefined) {
      explicitRelease = await database.models.releases.findById(
        options.toRelease,
      );
      if (
        explicitRelease === null ||
        explicitRelease.channel_id !== channel.id
      ) {
        p.log.error(
          `Target Release ${options.toRelease} does not belong to ${channelName}.`,
        );
        process.exit(1);
      }
    }

    let explicitBundlePlatform: Platform | null = null;
    if (options.toBundle !== undefined) {
      const bundle = await database.models.bundles.findById(options.toBundle);
      if (bundle === null) {
        p.log.error(`No Bundle with id ${options.toBundle}.`);
        process.exit(1);
      }
      explicitBundlePlatform = bundle.platform;
    }

    const platforms = explicitRelease
      ? [explicitRelease.platform]
      : explicitBundlePlatform
        ? [explicitBundlePlatform]
        : options.platform
          ? [options.platform]
          : PLATFORMS;
    if (
      options.platform !== undefined &&
      platforms.some((platform) => platform !== options.platform)
    ) {
      p.log.error("The explicit rollback target does not match --platform.");
      process.exit(1);
    }

    const targets: RollbackTarget[] = [];
    for (const platform of platforms) {
      const releases = await readChannelReleases(
        database,
        channel.id,
        platform,
      );
      const scopedReleases = explicitRelease
        ? releases.filter(
            ({ scope_key }) => scope_key === explicitRelease.scope_key,
          )
        : releases;
      const source = scopedReleases.find(({ enabled }) => enabled);
      if (source === undefined) {
        p.log.info(
          `No enabled Release on ${channelName}/${platform}; skipping.`,
        );
        continue;
      }
      const target =
        options.embedded || options.toBundle !== undefined
          ? null
          : (explicitRelease ?? selectDefaultTarget(releases, source));
      if (explicitRelease !== null && explicitRelease.id >= source.id) {
        p.log.error("--to-release must identify an earlier Release.");
        process.exit(1);
      }
      targets.push({
        source,
        target,
        ...(options.toBundle !== undefined
          ? { toBundleId: options.toBundle }
          : options.embedded || target === null
            ? { toBundleId: null }
            : {}),
      });
    }
    if (targets.length === 0) {
      p.log.error(`Nothing to roll back on ${channelName}.`);
      process.exit(1);
    }

    p.log.message(ui.title(`Rollback ${channelName}`));
    for (const target of targets) p.log.message(summarizeTarget(target));
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        p.log.error(
          "Cannot prompt in a non-interactive shell. Re-run with -y.",
        );
        process.exit(1);
      }
      const confirmed = await p.confirm({
        initialValue: false,
        message: `Create ${targets.length} forward rollback Release(s)?`,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    const results = await rollbackReleases({
      database,
      rollbacks: targets.map(({ source, target, toBundleId }) => ({
        releaseId: source.id,
        ...(target === null ? { toBundleId } : { toReleaseId: target.id }),
      })),
    });
    for (const result of results) {
      const release = result.release;
      if (release === null)
        throw new Error("Rollback Release was not persisted.");
      p.log.success(
        `Created ${ui.id(release.id)} for ${ui.platform(release.platform)}.`,
      );
      p.log.info(
        `  Bundle ${release.bundle_id === null ? "Embedded" : ui.id(release.bundle_id)}`,
      );
    }
  } finally {
    await safeDispose(database);
  }
};
