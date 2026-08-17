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
  readonly platform?: Platform;
  readonly target?: string;
  readonly yes?: boolean;
}

interface RollbackTarget {
  readonly source: ReleaseRow;
  readonly fallback: ReleaseRow | null;
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
      target.fallback === null
        ? ui.warning("Built-in app")
        : ui.id(target.fallback.id),
    ),
    ui.kv("Bundle", target.fallback?.bundle_id ?? ui.warning("Built-in app")),
    ui.kv("Action", `Disable ${ui.id(target.source.id)}`),
  ]);

const selectDefaultTarget = (
  releases: readonly ReleaseRow[],
  source: ReleaseRow,
): ReleaseRow | null => {
  return (
    releases.find(
      (release) =>
        release.enabled &&
        release.kind === "BUNDLE" &&
        release.scope_key === source.scope_key &&
        release.id < source.id,
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

    const targets: RollbackTarget[] = [];
    if (options.target !== undefined) {
      const bundle = await database.models.bundles.findById(options.target);
      if (bundle === null) {
        p.log.error(`No Bundle with id ${options.target}.`);
        process.exit(1);
      }
      if (
        options.platform !== undefined &&
        bundle.platform !== options.platform
      ) {
        p.log.error(
          `Bundle ${options.target} is on ${bundle.platform}, not ${options.platform}.`,
        );
        process.exit(1);
      }
      const releases = await readChannelReleases(
        database,
        channel.id,
        bundle.platform,
      );
      const matching = releases.filter(
        (release) => release.bundle_id === bundle.id,
      );
      const source = matching.find(({ enabled }) => enabled);
      if (source === undefined) {
        if (matching.length > 0) {
          p.log.info(
            `Bundle ${options.target} is already disabled. No changes.`,
          );
          return;
        }
        p.log.error(
          `No Release for Bundle ${options.target} on ${channelName}/${bundle.platform}.`,
        );
        process.exit(1);
      }
      targets.push({
        fallback: selectDefaultTarget(releases, source),
        source,
      });
    } else {
      const platforms = options.platform ? [options.platform] : PLATFORMS;
      for (const platform of platforms) {
        const releases = await readChannelReleases(
          database,
          channel.id,
          platform,
        );
        const source = releases.find(
          ({ enabled, kind }) => enabled && kind === "BUNDLE",
        );
        if (source === undefined) {
          p.log.info(
            `No enabled Release on ${channelName}/${platform}; skipping.`,
          );
          continue;
        }
        targets.push({
          fallback: selectDefaultTarget(releases, source),
          source,
        });
      }
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
        message: `Disable ${targets.length} current Release(s)?`,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    const results = await rollbackReleases({
      database,
      rollbacks: targets.map(({ source }) => ({
        expectedRevision: source.revision,
        releaseId: source.id,
      })),
    });
    for (const result of results) {
      const release = result.release;
      if (release === null) throw new Error("Release was not persisted.");
      p.log.success(
        `Disabled ${ui.id(release.id)} for ${ui.platform(release.platform)}.`,
      );
    }
  } finally {
    await safeDispose(database);
  }
};
