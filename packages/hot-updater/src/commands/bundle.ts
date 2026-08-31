import { setTimeout as sleep } from "timers/promises";

import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  Bundle,
  BundleRepository,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { createDatabaseClient } from "@hot-updater/plugin-core";

import { ui } from "../utils/cli-ui";
import { printBanner } from "../utils/printBanner";

export {
  handleReleaseList as handleBundleList,
  handleReleaseShow as handleBundleShow,
} from "./release";

export interface BundleMutationOptions {
  json?: boolean;
  yes?: boolean;
}

export type BundleDeleteOptions = BundleMutationOptions;

const DELETE_VERIFY_ATTEMPTS = 12;
const DELETE_VERIFY_DELAY_MS = 1000;
const STANDALONE_DATABASE_NAME = "standalone-repository";
const STANDALONE_DELETE_LOOKUP_LIMIT = 100;
const RELEASE_REFERENCE_PAGE_SIZE = 1_000;

interface BundleReleaseReferences {
  readonly count: number;
  readonly ids: readonly string[];
}

const formatBundleSummary = (bundle: Bundle): string => {
  const lines = [
    ui.kv("Platform", ui.platform(bundle.platform)),
    ui.kv("File ID", ui.id(bundle.id)),
    ui.kv("File hash", ui.muted(bundle.fileHash)),
    ui.kv("Storage", ui.muted(bundle.storageUri)),
    bundle.manifestStorageUri
      ? ui.kv("Manifest", ui.muted(bundle.manifestStorageUri))
      : null,
    ui.kv("Patches", String(bundle.patches?.length ?? 0)),
  ].filter((line): line is string => line !== null);
  return ui.block("Artifact", lines);
};

const loadReleaseReferences = async (
  database: BundleRepository,
  bundleId: string,
): Promise<BundleReleaseReferences> => {
  const releases: ReleaseRow[] = [];
  const seenReleaseIds = new Set<string>();
  const seenCursors = new Set<string>();
  let beforeReleaseId: string | undefined;

  for (;;) {
    const page = await database.models.releases.findMany({
      ...(beforeReleaseId === undefined ? {} : { beforeReleaseId }),
      bundleId,
      limit: RELEASE_REFERENCE_PAGE_SIZE,
    });
    for (const release of page) {
      if (release.bundle_id !== bundleId) {
        throw new Error(
          `Database returned Release ${release.id} for the wrong Bundle.`,
        );
      }
      if (seenReleaseIds.has(release.id)) {
        throw new Error(
          `Database returned Release ${release.id} more than once while reading Bundle references.`,
        );
      }
      seenReleaseIds.add(release.id);
      releases.push(release);
    }

    if (page.length < RELEASE_REFERENCE_PAGE_SIZE) {
      return {
        count: releases.length,
        ids: releases.map(({ id }) => id),
      };
    }

    const nextCursor = page.at(-1)?.id;
    if (
      nextCursor === undefined ||
      nextCursor === beforeReleaseId ||
      seenCursors.has(nextCursor)
    ) {
      throw new Error(
        `Database cannot provide safe Release pagination for Bundle ${bundleId}.`,
      );
    }
    seenCursors.add(nextCursor);
    beforeReleaseId = nextCursor;
  }
};

const formatReferenceBlockers = (
  entries: readonly {
    readonly bundle: Bundle;
    readonly references: BundleReleaseReferences;
  }[],
): string =>
  entries
    .map(
      ({ bundle, references }) =>
        `File ID ${bundle.id}: referenced by IDs ${references.ids.join(", ")}`,
    )
    .join("\n");

const refuseNonInteractiveMutation = (action: string): never => {
  p.log.error(
    `Cannot ${action} a bundle without confirmation in a non-interactive shell. Re-run with -y, or use a TTY.`,
  );
  process.exit(1);
};

const safeDispose = async (databasePlugin: BundleRepository): Promise<void> => {
  try {
    await databasePlugin.dispose?.();
  } catch (err) {
    p.log.warn(
      `Database plugin dispose failed (cleanup-only, original error preserved): ${
        (err as Error)?.message ?? String(err)
      }`,
    );
  }
};

export const handleBundleDelete = async (
  bundleIds: string[],
  options: BundleDeleteOptions = {},
) => {
  printBanner();

  const ids = [...new Set(bundleIds ?? [])];
  if (ids.length === 0) {
    p.log.error("Provide at least one file ID.");
    process.exit(1);
  }

  const config = await loadConfig(null);
  const databasePlugin = config.database;
  const database = createDatabaseClient(databasePlugin);
  try {
    // Resolve targets from management snapshots. The standard
    // standalone API caps list requests at 100 IDs, so only that remote plugin
    // uses bounded lookups.
    const lookupBatches =
      databasePlugin.name === STANDALONE_DATABASE_NAME
        ? Array.from(
            {
              length: Math.ceil(ids.length / STANDALONE_DELETE_LOOKUP_LIMIT),
            },
            (_, index) =>
              ids.slice(
                index * STANDALONE_DELETE_LOOKUP_LIMIT,
                (index + 1) * STANDALONE_DELETE_LOOKUP_LIMIT,
              ),
          )
        : [ids];
    const matchedBundles: Bundle[] = [];
    for (const batch of lookupBatches) {
      const { data } = await database.getBundles({
        where: { id: { in: batch } },
        limit: batch.length,
      });
      matchedBundles.push(...data);
    }
    const matchedById = new Map(
      matchedBundles.map((bundle) => [bundle.id, bundle]),
    );
    const targets = ids.flatMap((id) => {
      const bundle = matchedById.get(id);
      if (!bundle) {
        p.log.info(`No bundle with file ID ${id}. Skipping.`);
        return [];
      }
      return [bundle];
    });
    if (targets.length === 0) {
      p.log.info("No matching bundle records. No changes.");
      return;
    }

    const targetReferences = await Promise.all(
      targets.map(async (bundle) => ({
        bundle,
        references: await loadReleaseReferences(databasePlugin, bundle.id),
      })),
    );
    const blockers = targetReferences.filter(
      ({ references }) => references.count > 0,
    );
    if (blockers.length > 0) {
      throw new Error(
        `Cannot delete Bundle records referenced by Releases. Disable and delete these Releases first:\n${formatReferenceBlockers(blockers)}`,
      );
    }

    const [firstTarget] = targets;
    if (firstTarget && targets.length === 1) {
      p.log.message(formatBundleSummary(firstTarget));
    } else {
      p.log.message(`${targets.length} bundle records will be deleted.`);
    }

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        refuseNonInteractiveMutation("delete");
      }
      const confirmed = await p.confirm({
        message:
          targets.length === 1
            ? "Delete this bundle record?"
            : `Delete ${targets.length} bundle records?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    await database.mutate(async (mutation) => {
      for (const bundle of targets) {
        await mutation.deleteBundleById(bundle.id);
      }
    });

    const stillPresent: string[] = [];
    for (const bundle of targets) {
      const deleted = await waitForDeletedBundle(database, bundle.id);
      if (!deleted) {
        stillPresent.push(bundle.id);
      }
    }
    if (stillPresent.length > 0) {
      p.log.error(
        `Verification failed: ${stillPresent.length} bundle record(s) still exist (file IDs: ${stillPresent.join(", ")}).`,
      );
      process.exit(1);
    }

    if (firstTarget && targets.length === 1) {
      p.log.success("Deleted bundle record.");
      p.log.info(ui.kv("File ID", ui.id(firstTarget.id)));
    } else {
      p.log.success(`Deleted ${targets.length} bundle records.`);
    }
    p.log.info(
      "Storage objects are unchanged. Preview cleanup with hot-updater storage prune --dry-run.",
    );
  } finally {
    await safeDispose(databasePlugin);
  }
};

async function waitForDeletedBundle(
  database: ReturnType<typeof createDatabaseClient>,
  bundleId: string,
) {
  for (let attempt = 0; attempt < DELETE_VERIFY_ATTEMPTS; attempt += 1) {
    const refetched = await database.getBundleById(bundleId);
    if (!refetched) {
      return true;
    }

    if (attempt < DELETE_VERIFY_ATTEMPTS - 1) {
      await sleep(DELETE_VERIFY_DELAY_MS);
    }
  }

  return false;
}
