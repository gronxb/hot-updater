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

/** Contents short enough to show, such as `react-native-screens@4.25.2`. */
const readableContents = (source: FingerprintSource): string | null =>
  source.type === "contents" &&
  typeof source.contents === "string" &&
  source.contents.length <= 120 &&
  !source.contents.includes("\n")
    ? source.contents
    : null;

/**
 * A source as people read it: a file path, a value such as
 * `react-native-screens@4.25.2` or `android:hermesEnabled=true`, or the
 * source's id when its contents are long.
 */
function getSourcePath(source: FingerprintSource): string {
  if (!("id" in source)) {
    return source.filePath;
  }
  const contents = readableContents(source);
  if (contents === null) return source.id;
  return source.id.startsWith("setting:")
    ? `${source.id.slice("setting:".length)}=${contents}`
    : source.id === "nativeVersion"
      ? `nativeVersion=${contents}`
      : contents;
}

/**
 * A changed source with its value before and after, such as
 * `react-native-screens 4.25.2 → 4.26.0`, when both are short.
 */
function describeChange(
  before: FingerprintSource,
  after: FingerprintSource,
): string {
  const from = readableContents(before);
  const to = readableContents(after);
  if (from === null || to === null || !("id" in before)) {
    return getSourcePath(before);
  }
  const at = from.lastIndexOf("@");
  if (at > 0 && to.startsWith(from.slice(0, at + 1))) {
    return `${from.slice(0, at)} ${from.slice(at + 1)} → ${to.slice(at + 1)}`;
  }
  const label = before.id.startsWith("setting:")
    ? before.id.slice("setting:".length)
    : before.id;
  return `${label} ${from} → ${to}`;
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
      sourcePath = describeChange(item.beforeSource, item.afterSource);
      break;
  }

  return `${color(`${prefix} ${sourcePath}`)}`;
}

/** A fingerprint diff as the sources it added, removed, and changed, as people read them. */
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
      item.op === "changed"
        ? [describeChange(item.beforeSource, item.afterSource)]
        : [],
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

  // One file per line, under its kind: a list of them would wrap.
  const kinds = [
    { label: "Added", files: added, color: colors.green },
    { label: "Removed", files: removed, color: colors.red },
    { label: "Changed", files: changed, color: colors.yellow },
  ].filter(({ files }) => files.length > 0);
  const width = Math.max(...kinds.map(({ label }) => label.length)) + 2;
  p.log.info(
    [
      `${platform} fingerprint changes`,
      ...kinds.flatMap(({ label, files, color }) =>
        files.map((file, index) =>
          index === 0
            ? `${color(label.padEnd(width))}${file}`
            : `${" ".repeat(width)}${file}`,
        ),
      ),
    ].join("\n"),
  );
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
