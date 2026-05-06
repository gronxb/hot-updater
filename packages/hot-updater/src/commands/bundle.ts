import { colors, loadConfig, p } from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  Platform,
} from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

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

export interface BundleListOptions {
  channel?: string;
  json?: boolean;
  platform?: Platform;
  limit?: number;
}

export interface BundleMutationOptions {
  yes?: boolean;
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

const colorizeCell = (field: ListField, value: string): string => {
  if (!value) return value;
  if (field === "id") return colors.yellow(value);
  if (field === "channel") return colors.blue(value);
  if (field === "platform") return colors.cyan(value);
  if (field === "enabled")
    return value === "yes" ? colors.green(value) : colors.red(value);
  if (field === "shouldForceUpdate") {
    return value === "yes" ? colors.yellow(value) : colors.dim(value);
  }
  if (field === "gitCommitHash") return colors.dim(value);
  return value;
};

const tabulate = (bundles: Bundle[]): string => {
  if (bundles.length === 0) {
    return colors.dim("(no bundles)");
  }
  const rows = bundles.map(formatRow);
  const widths = {} as Record<ListField, number>;
  for (const field of LIST_FIELDS) {
    widths[field] = Math.max(field.length, ...rows.map((r) => r[field].length));
  }
  const header = LIST_FIELDS.map((f) =>
    colors.bold(f.padEnd(widths[f] ?? f.length)),
  ).join("  ");
  const body = rows.map((r) =>
    LIST_FIELDS.map((f) =>
      colorizeCell(f, r[f].padEnd(widths[f] ?? f.length)),
    ).join("  "),
  );
  return [header, ...body].join("\n");
};

const formatStatus = (enabled: boolean): string =>
  enabled ? colors.green("enabled") : colors.red("disabled");

const formatBundleSummary = (bundle: Bundle, nextEnabled?: boolean): string => {
  const status =
    nextEnabled === undefined || bundle.enabled === nextEnabled
      ? formatStatus(bundle.enabled)
      : `${formatStatus(bundle.enabled)} -> ${formatStatus(nextEnabled)}`;
  return [
    `  ${colors.bold(colors.cyan(bundle.platform))} / ${colors.blue(bundle.channel)}`,
    `    ID:      ${colors.yellow(bundle.id)}`,
    `    Status:  ${status}`,
    bundle.targetAppVersion
      ? `    Version: ${colors.magenta(bundle.targetAppVersion)}`
      : null,
    bundle.message ? `    Message: ${bundle.message}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
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
      p.log.info(`  ${colors.yellow(bundleId)}`);
    }
  } finally {
    await safeOnUnmount(databasePlugin);
  }
};
