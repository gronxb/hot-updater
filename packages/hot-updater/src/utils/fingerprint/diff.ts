import { colors, getCwd, p } from "@hot-updater/cli-tools";

import type {
  FingerprintSource,
  FingerprintOptions,
  FingerprintResult,
} from "./common";
import { nativeFingerprint } from "./nativeFingerprint";

export type FingerprintDiffItem =
  | {
      op: "added";
      addedSource: FingerprintSource;
    }
  | {
      op: "removed";
      removedSource: FingerprintSource;
    }
  | {
      op: "changed";
      beforeSource: FingerprintSource;
      afterSource: FingerprintSource;
    };

const sourceKey = (source: FingerprintSource) =>
  source.type === "contents"
    ? `contents:${source.id}`
    : `${source.type}:${source.filePath}`;

/**
 * Compares a saved fingerprint with the project's fingerprint now, source by
 * source, whichever engine computes it.
 */
export async function getFingerprintDiff(
  oldFingerprint: FingerprintResult,
  options: FingerprintOptions,
): Promise<FingerprintDiffItem[]> {
  const current = await nativeFingerprint(getCwd(), options);
  const before = new Map(
    oldFingerprint.sources.map((source) => [sourceKey(source), source]),
  );
  const after = new Map(
    current.sources.map((source) => [sourceKey(source), source]),
  );
  const diff: FingerprintDiffItem[] = [];
  for (const [key, beforeSource] of before) {
    const afterSource = after.get(key);
    if (!afterSource) {
      diff.push({ op: "removed", removedSource: beforeSource });
    } else if (afterSource.hash !== beforeSource.hash) {
      diff.push({ op: "changed", beforeSource, afterSource });
    }
  }
  for (const [key, afterSource] of after) {
    if (!before.has(key)) diff.push({ op: "added", addedSource: afterSource });
  }
  return diff;
}

function getSourcePath(source: FingerprintSource): string {
  if (source.type === "file" || source.type === "dir") {
    return source.filePath;
  }
  if ("id" in source) {
    return source.id;
  }
  return source.type;
}

export function formatDiffItem(item: FingerprintDiffItem): string {
  const typeColor = {
    added: colors.green,
    removed: colors.red,
    changed: colors.yellow,
  };

  const color = typeColor[item.op];
  const prefix = item.op === "added" ? "+" : item.op === "removed" ? "-" : "~";

  let sourcePath: string;
  switch (item.op) {
    case "added":
      sourcePath = getSourcePath(item.addedSource);
      break;
    case "removed":
      sourcePath = getSourcePath(item.removedSource);
      break;
    case "changed":
      sourcePath = getSourcePath(item.beforeSource);
      break;
  }

  return `${color(`${prefix} ${sourcePath}`)}`;
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
      item.op === "added" ? [getSourcePath(item.addedSource)] : [],
    ),
    removed: diff.flatMap((item) =>
      item.op === "removed" ? [getSourcePath(item.removedSource)] : [],
    ),
    changed: diff.flatMap((item) =>
      item.op === "changed" ? [getSourcePath(item.beforeSource)] : [],
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

export function showFingerprintDiff(
  diff: FingerprintDiffItem[],
  platform: string,
): void {
  showFingerprintChanges(summarizeFingerprintDiff(diff), platform);
}

export function getDiffSummary(diff: FingerprintDiffItem[]): string {
  if (diff.length === 0) {
    return "No changes detected";
  }

  const added = diff.filter((item) => item.op === "added").length;
  const removed = diff.filter((item) => item.op === "removed").length;
  const changed = diff.filter((item) => item.op === "changed").length;

  const parts: string[] = [];
  if (added > 0) {
    parts.push(`${added} added`);
  }
  if (removed > 0) {
    parts.push(`${removed} removed`);
  }
  if (changed > 0) {
    parts.push(`${changed} changed`);
  }

  return parts.join(", ");
}
