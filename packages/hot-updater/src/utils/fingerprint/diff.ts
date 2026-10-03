import { colors, p } from "@hot-updater/cli-tools";

import type { FingerprintResult, FingerprintSource } from "./common";

export type FingerprintDiffItem =
  | { op: "added"; addedSource: FingerprintSource }
  | { op: "removed"; removedSource: FingerprintSource }
  | {
      op: "changed";
      beforeSource: FingerprintSource;
      afterSource: FingerprintSource;
    };

const sourcePath = (source: FingerprintSource) =>
  "filePath" in source ? source.filePath : source.id;

export function getFingerprintDiff(
  oldFingerprint: FingerprintResult,
  newFingerprint: FingerprintResult,
): FingerprintDiffItem[] {
  const before = new Map(
    oldFingerprint.sources.map((source) => [sourcePath(source), source]),
  );
  const after = new Map(
    newFingerprint.sources.map((source) => [sourcePath(source), source]),
  );
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .flatMap((key): FingerprintDiffItem[] => {
      const left = before.get(key);
      const right = after.get(key);
      if (!left && right) return [{ op: "added", addedSource: right }];
      if (left && !right) return [{ op: "removed", removedSource: left }];
      if (left && right && left.hash !== right.hash) {
        return [{ op: "changed", beforeSource: left, afterSource: right }];
      }
      return [];
    });
}

export function formatDiffItem(item: FingerprintDiffItem): string {
  const prefix = item.op === "added" ? "+" : item.op === "removed" ? "-" : "~";
  const source =
    item.op === "added"
      ? item.addedSource
      : item.op === "removed"
        ? item.removedSource
        : item.beforeSource;
  const color =
    item.op === "added"
      ? colors.green
      : item.op === "removed"
        ? colors.red
        : colors.yellow;
  return color(`${prefix} ${sourcePath(source)}`);
}

export function showFingerprintDiff(
  diff: FingerprintDiffItem[],
  platform: string,
) {
  if (diff.length === 0) return;
  p.log.info(`${colors.bold(`${platform} Fingerprint Changes:`)}`);
  for (const item of diff) p.log.info(`  ${formatDiffItem(item)}`);
}

export function getDiffSummary(diff: FingerprintDiffItem[]): string {
  if (diff.length === 0) return "No changes detected";
  return (["added", "removed", "changed"] as const)
    .map((op) => [op, diff.filter((item) => item.op === op).length] as const)
    .filter(([, count]) => count > 0)
    .map(([op, count]) => `${count} ${op}`)
    .join(", ");
}

/** A fingerprint diff as the source paths it added, removed, and changed. */
export interface FingerprintChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export function summarizeFingerprintDiff(
  diff: readonly FingerprintDiffItem[],
): FingerprintChanges {
  return {
    added: diff.flatMap((item) =>
      item.op === "added" ? [sourcePath(item.addedSource)] : [],
    ),
    removed: diff.flatMap((item) =>
      item.op === "removed" ? [sourcePath(item.removedSource)] : [],
    ),
    changed: diff.flatMap((item) =>
      item.op === "changed" ? [sourcePath(item.beforeSource)] : [],
    ),
  };
}

export function showFingerprintChanges(
  { added, removed, changed }: FingerprintChanges,
  platform: string,
): void {
  if (added.length + removed.length + changed.length === 0) {
    return;
  }

  p.log.info(`${colors.bold(`${platform} Fingerprint Changes:`)}`);

  if (added.length > 0) {
    p.log.info(`  ${colors.green("Added:")} ${added.join(", ")}`);
  }

  if (removed.length > 0) {
    p.log.info(`  ${colors.red("Removed:")} ${removed.join(", ")}`);
  }

  if (changed.length > 0) {
    p.log.info(`  ${colors.yellow("Changed:")} ${changed.join(", ")}`);
  }
}
