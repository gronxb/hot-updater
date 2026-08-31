import { loadConfig, p } from "@hot-updater/cli-tools";
import type { BundleRepository, ReleaseRow } from "@hot-updater/plugin-core";
import { promoteRelease } from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";

export type PromoteAction = "copy" | "move";

export interface PromoteOptions {
  readonly action?: PromoteAction;
  readonly target: string;
  readonly yes?: boolean;
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

const summarizePlan = (
  source: ReleaseRow,
  sourceChannel: string,
  targetChannel: string,
  action: PromoteAction,
) =>
  ui.block(`Promote Release (${action})`, [
    ui.kv("Source ID", ui.id(source.id)),
    ui.kv("Platform", ui.platform(source.platform)),
    ui.kv("From", ui.channel(sourceChannel)),
    ui.kv("To", ui.channel(targetChannel)),
    ui.kv("Storage", ui.muted("reused; no upload or copy")),
    ui.kv("Target enabled", "yes"),
    ui.kv("Target rollout", "100%"),
    ui.kv("Target cohorts", ui.muted("(none)")),
    ui.kv("Rollout seed", ui.muted("new ID")),
    ui.kv(
      "Source Release",
      action === "move" ? "disabled atomically" : "remains unchanged",
    ),
  ]);

export const handlePromote = async (
  sourceReleaseId: string,
  options: PromoteOptions,
) => {
  printBanner();
  const targetChannel = options.target.trim();
  if (targetChannel.length === 0) {
    p.log.error("--target is required.");
    process.exit(1);
  }
  const action = options.action ?? "copy";
  const config = await loadConfig(null);
  const database = config.database;
  try {
    const [source, channels] = await Promise.all([
      database.models.releases.findById(sourceReleaseId),
      database.models.channels.list({}),
    ]);
    if (source === null) {
      p.log.error(`No Release with id ${sourceReleaseId}.`);
      process.exit(1);
    }
    const sourceChannel =
      channels.channels.find(({ id }) => id === source.channel_id)?.name ??
      source.channel_id;
    p.log.message(summarizePlan(source, sourceChannel, targetChannel, action));
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        p.log.error(
          "Cannot prompt in a non-interactive shell. Re-run with -y.",
        );
        process.exit(1);
      }
      const confirmed = await p.confirm({
        initialValue: false,
        message: `${action === "copy" ? "Promote" : "Move"} this Release to ${targetChannel}?`,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        p.log.info("Aborted.");
        process.exit(2);
      }
    }
    const result = await promoteRelease({
      action,
      database,
      expectedRevision: source.revision,
      releaseId: source.id,
      targetChannel,
    });
    const promoted = result.target.release;
    if (promoted === null)
      throw new Error("Promoted Release was not persisted.");
    p.log.success(
      action === "copy"
        ? `Promoted Release to ${targetChannel}.`
        : `Moved delivery policy to ${targetChannel}.`,
    );
    p.log.info(ui.kv("ID", ui.id(promoted.id)));
  } finally {
    await safeDispose(database);
  }
};
