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
