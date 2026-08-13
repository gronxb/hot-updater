import { setTimeout as sleep } from "timers/promises";

import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  Bundle,
  BundleRepository,
  Platform,
} from "@hot-updater/plugin-core";
import { createDatabaseClient } from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
const LIST_FIELDS = [
  "id",
  "platform",
  "fileHash",
  "storageUri",
  "gitCommitHash",
] as const satisfies readonly (keyof Bundle)[];

type ListField = (typeof LIST_FIELDS)[number];

const LIST_COLUMNS = [
  { key: "id", label: "ID", format: ui.id },
  { key: "platform", label: "Platform", format: ui.platform },
  { key: "fileHash", label: "File Hash", format: ui.muted },
  { key: "storageUri", label: "Storage", format: ui.muted },
  { key: "gitCommitHash", label: "Commit", format: ui.muted },
] as const satisfies readonly {
  key: ListField;
  label: string;
  format?: (value: string) => string;
}[];

export interface BundleListOptions {
  json?: boolean;
  platform?: Platform;
  limit?: number;
}

export interface BundleMutationOptions {
  json?: boolean;
  yes?: boolean;
}

export type BundleDeleteOptions = BundleMutationOptions;

const DEFAULT_LIMIT = 20;
const DELETE_VERIFY_ATTEMPTS = 12;
const DELETE_VERIFY_DELAY_MS = 1000;

const formatRow = (bundle: Bundle): Record<ListField, string> => {
  const out = {} as Record<ListField, string>;
  for (const field of LIST_FIELDS) {
    const v = bundle[field];
    if (field === "gitCommitHash" && typeof v === "string") {
      out[field] = v.slice(0, 7);
    } else if (field === "fileHash" && typeof v === "string") {
      out[field] = v.slice(0, 12);
    } else if (v == null) {
      out[field] = "";
    } else {
      out[field] = String(v);
    }
  }
  return out;
};

const tabulate = (bundles: Bundle[]): string => {
  if (bundles.length === 0) {
    return ui.muted("(no bundles)");
  }
  return ui.table(LIST_COLUMNS, bundles.map(formatRow));
};

const formatBundleSummary = (bundle: Bundle): string => {
  const lines = [
    ui.kv("Platform", ui.platform(bundle.platform)),
    ui.kv("ID", ui.id(bundle.id)),
    ui.kv("File hash", ui.muted(bundle.fileHash)),
    ui.kv("Storage", ui.muted(bundle.storageUri)),
    bundle.manifestStorageUri
      ? ui.kv("Manifest", ui.muted(bundle.manifestStorageUri))
      : null,
    ui.kv("Patches", String(bundle.patches?.length ?? 0)),
  ].filter((line): line is string => line !== null);
  return ui.block("Artifact", lines);
};

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

export const handleBundleList = async (options: BundleListOptions = {}) => {
  if (!options.json) {
    printBanner();
  }

  const config = await loadConfig(null);

  const databasePlugin = config.database;
  const database = createDatabaseClient(databasePlugin);
  try {
    const limit =
      Number.isInteger(options.limit) && options.limit! > 0
        ? options.limit!
        : DEFAULT_LIMIT;
    const result = await database.getBundles({
      where: {
        platform: options.platform,
      },
      limit,
    });
    console.log(
      options.json ? JSON.stringify(result, null, 2) : tabulate(result.data),
    );
  } finally {
    await safeDispose(databasePlugin);
  }
};

export const handleBundleShow = async (
  bundleId: string,
  options: Pick<BundleMutationOptions, "json"> = {},
) => {
  if (!options.json) {
    printBanner();
  }

  const config = await loadConfig(null);
  const databasePlugin = config.database;
  const database = createDatabaseClient(databasePlugin);
  try {
    const bundle = await database.getBundleById(bundleId);
    if (!bundle) {
      p.log.error(`No bundle with id ${bundleId}.`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }

    p.log.message(formatBundleSummary(bundle));
  } finally {
    await safeDispose(databasePlugin);
  }
};

export const handleBundleDelete = async (
  bundleIds: string[],
  options: BundleDeleteOptions = {},
) => {
  printBanner();

  const ids = bundleIds ?? [];
  if (ids.length === 0) {
    p.log.error("Provide at least one bundle id.");
    process.exit(1);
  }

  const config = await loadConfig(null);
  const databasePlugin = config.database;
  const database = createDatabaseClient(databasePlugin);
  try {
    // Resolve the target set from the given ids.
    const fetched = await Promise.all(
      ids.map((id) => database.getBundleById(id)),
    );
    const targets: Bundle[] = [];
    fetched.forEach((bundle, index) => {
      if (bundle) {
        targets.push(bundle);
      } else {
        p.log.info(`No bundle with id ${ids[index]}. Skipping.`);
      }
    });
    if (targets.length === 0) {
      p.log.info("No matching bundle records. No changes.");
      return;
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
        `Verification failed: ${stillPresent.length} bundle record(s) still exist (${stillPresent.join(", ")}).`,
      );
      process.exit(1);
    }

    if (firstTarget && targets.length === 1) {
      p.log.success("Deleted bundle record.");
      p.log.info(`  ${ui.id(firstTarget.id)}`);
    } else {
      p.log.success(`Deleted ${targets.length} bundle records.`);
    }
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
