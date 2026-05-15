import { loadConfig, p } from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  Platform,
} from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";

const LIST_FIELDS = [
  "id",
  "channel",
  "platform",
  "enabled",
  "targetAppVersion",
  "shouldForceUpdate",
  "gitCommitHash",
  "message",
] as const satisfies readonly (keyof Bundle)[];

type ListField = (typeof LIST_FIELDS)[number];

const LIST_COLUMNS = [
  { key: "id", label: "ID", format: ui.id },
  { key: "channel", label: "Channel", format: ui.channel },
  { key: "platform", label: "Platform", format: ui.platform },
  {
    key: "enabled",
    label: "Enabled",
    format: (value: string) =>
      value.trim() === "yes" ? ui.success(value) : ui.danger(value),
  },
  { key: "targetAppVersion", label: "Version", format: ui.version },
  {
    key: "shouldForceUpdate",
    label: "Force Update",
    format: (value: string) =>
      value.trim() === "yes" ? ui.warning(value) : ui.muted(value),
  },
  { key: "gitCommitHash", label: "Commit", format: ui.muted },
  { key: "message", label: "Message" },
] as const satisfies readonly {
  key: ListField;
  label: string;
  format?: (value: string) => string;
}[];

export interface BundleListOptions {
  channel?: string;
  json?: boolean;
  platform?: Platform;
  limit?: number;
}

export interface BundleMutationOptions {
  json?: boolean;
  yes?: boolean;
}

export interface BundleUpdateOptions extends BundleMutationOptions {
  clearTargetCohorts?: boolean;
  forceUpdate?: boolean;
  rolloutCohortCount?: number;
  targetCohorts?: string;
}

const DEFAULT_LIMIT = 20;

const formatRow = (bundle: Bundle): Record<ListField, string> => {
  const out = {} as Record<ListField, string>;
  for (const field of LIST_FIELDS) {
    const v = bundle[field];
    if (field === "enabled" || field === "shouldForceUpdate") {
      out[field] = v ? "yes" : "no";
    } else if (field === "gitCommitHash" && typeof v === "string") {
      out[field] = v.slice(0, 7);
    } else if (field === "message" && typeof v === "string") {
      out[field] = v.slice(0, 60);
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

const formatBundleSummary = (bundle: Bundle, nextEnabled?: boolean): string => {
  const status =
    nextEnabled === undefined || bundle.enabled === nextEnabled
      ? ui.status(bundle.enabled)
      : `${ui.status(bundle.enabled)} -> ${ui.status(nextEnabled)}`;
  const lines = [
    `  ${ui.platform(bundle.platform)} / ${ui.channel(bundle.channel)}`,
    ui.kv("ID", ui.id(bundle.id)),
    ui.kv("Status", status),
    bundle.targetAppVersion
      ? ui.kv("Version", ui.version(bundle.targetAppVersion))
      : null,
    bundle.message ? ui.kv("Message", bundle.message) : null,
  ].filter((line): line is string => line !== null);
  return ui.block("Bundle", lines);
};

const parseTargetCohorts = (value: string | undefined): string[] | null => {
  if (value === undefined) {
    return null;
  }

  return value
    .split(",")
    .map((cohort) => cohort.trim())
    .filter(Boolean);
};

const refuseNonInteractiveMutation = (action: string): never => {
  p.log.error(
    `Cannot ${action} a bundle without confirmation in a non-interactive shell. Re-run with -y, or use a TTY.`,
  );
  process.exit(1);
};

const safeOnUnmount = async (databasePlugin: DatabasePlugin): Promise<void> => {
  try {
    await databasePlugin.onUnmount?.();
  } catch (err) {
    p.log.warn(
      `Database plugin onUnmount failed (cleanup-only, original error preserved): ${
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

  const databasePlugin: DatabasePlugin = await config.database();
  try {
    const limit =
      Number.isInteger(options.limit) && options.limit! > 0
        ? options.limit!
        : DEFAULT_LIMIT;
    const result = await databasePlugin.getBundles({
      where: {
        channel: options.channel,
        platform: options.platform,
      },
      limit,
    });
    console.log(
      options.json ? JSON.stringify(result, null, 2) : tabulate(result.data),
    );
  } finally {
    await safeOnUnmount(databasePlugin);
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
  const databasePlugin: DatabasePlugin = await config.database();
  try {
    const bundle = await databasePlugin.getBundleById(bundleId);
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
    await safeOnUnmount(databasePlugin);
  }
};

export const handleBundleSetEnabled = async (
  bundleId: string,
  nextEnabled: boolean,
  options: BundleMutationOptions = {},
) => {
  const action = nextEnabled ? "enable" : "disable";
  printBanner();

  const config = await loadConfig(null);

  const databasePlugin: DatabasePlugin = await config.database();
  try {
    const bundle = await databasePlugin.getBundleById(bundleId);
    if (!bundle) {
      p.log.error(`No bundle with id ${bundleId}.`);
      process.exit(1);
    }

    p.log.message(formatBundleSummary(bundle, nextEnabled));

    if (bundle.enabled === nextEnabled) {
      p.log.info(`Bundle is already ${action}d. No changes.`);
      return;
    }

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        refuseNonInteractiveMutation(action);
      }
      const confirmed = await p.confirm({
        message: `${nextEnabled ? "Enable" : "Disable"} this bundle?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    await databasePlugin.updateBundle(bundleId, { enabled: nextEnabled });
    await databasePlugin.commitBundle();

    const refetched = await databasePlugin.getBundleById(bundleId);
    if (!refetched) {
      p.log.warn(
        `${bundleId} was deleted between commit and verify; treating as ${action}d.`,
      );
    } else if (refetched.enabled !== nextEnabled) {
      p.log.error(
        `Verification failed: ${bundleId} is not ${action}d after update.`,
      );
      process.exit(1);
    } else {
      p.log.success(`${nextEnabled ? "Enabled" : "Disabled"} bundle.`);
      p.log.info(`  ${ui.id(bundleId)}`);
    }
  } finally {
    await safeOnUnmount(databasePlugin);
  }
};

export const handleBundleUpdate = async (
  bundleId: string,
  options: BundleUpdateOptions = {},
) => {
  if (!options.json) {
    printBanner();
  }

  const targetCohorts = parseTargetCohorts(options.targetCohorts);
  const patch: Partial<Bundle> = {};

  if (options.rolloutCohortCount !== undefined) {
    patch.rolloutCohortCount = options.rolloutCohortCount;
  }
  if (options.forceUpdate !== undefined) {
    patch.shouldForceUpdate = options.forceUpdate;
  }
  if (targetCohorts !== null) {
    patch.targetCohorts = targetCohorts;
  } else if (options.clearTargetCohorts) {
    patch.targetCohorts = null;
  }

  if (Object.keys(patch).length === 0) {
    p.log.error("No bundle update fields were provided.");
    process.exit(1);
  }

  const config = await loadConfig(null);
  const databasePlugin: DatabasePlugin = await config.database();
  try {
    const bundle = await databasePlugin.getBundleById(bundleId);
    if (!bundle) {
      p.log.error(`No bundle with id ${bundleId}.`);
      process.exit(1);
    }

    if (!options.json) {
      p.log.message(formatBundleSummary(bundle));
    }

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        refuseNonInteractiveMutation("update");
      }
      const confirmed = await p.confirm({
        message: "Update this bundle?",
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    await databasePlugin.updateBundle(bundleId, patch);
    await databasePlugin.commitBundle();

    const refetched = await databasePlugin.getBundleById(bundleId);
    if (!refetched) {
      p.log.error(`Verification failed: ${bundleId} is missing after update.`);
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(refetched, null, 2));
      return;
    }

    p.log.success("Updated bundle.");
    p.log.info(`  ${ui.id(bundleId)}`);
  } finally {
    await safeOnUnmount(databasePlugin);
  }
};

export const handleBundleDelete = async (
  bundleId: string,
  options: BundleMutationOptions = {},
) => {
  printBanner();

  const config = await loadConfig(null);
  const databasePlugin: DatabasePlugin = await config.database();
  try {
    const bundle = await databasePlugin.getBundleById(bundleId);
    if (!bundle) {
      p.log.info(`No bundle with id ${bundleId}. No changes.`);
      return;
    }

    p.log.message(formatBundleSummary(bundle));

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        refuseNonInteractiveMutation("delete");
      }
      const confirmed = await p.confirm({
        message: "Delete this bundle record?",
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }

    await databasePlugin.deleteBundle(bundle);
    await databasePlugin.commitBundle();

    const refetched = await databasePlugin.getBundleById(bundleId);
    if (refetched) {
      p.log.error(`Verification failed: ${bundleId} still exists.`);
      process.exit(1);
    }

    p.log.success("Deleted bundle record.");
    p.log.info(`  ${ui.id(bundleId)}`);
  } finally {
    await safeOnUnmount(databasePlugin);
  }
};
