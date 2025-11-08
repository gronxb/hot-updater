import type { FingerprintDiffItem, FingerprintSource } from "@expo/fingerprint";
import { diffFingerprintChangesAsync } from "@expo/fingerprint";
import { colors, getCwd, p } from "@hot-updater/cli-tools";
import {
  type FingerprintOptions,
  type FingerprintResult,
  getOtaFingerprintOptions,
} from "./common";

export async function getFingerprintDiff(
  oldFingerprint: FingerprintResult,
  options: FingerprintOptions,
): Promise<FingerprintDiffItem[]> {
  const projectPath = getCwd();
  return await diffFingerprintChangesAsync(
    oldFingerprint,
    projectPath,
    getOtaFingerprintOptions(options.platform, projectPath, options),
  );
}

function getSourcePath(source: FingerprintSource): string {
  if (source.type === "file" || source.type === "dir") {
    return source.filePath;
  }
  return source.id || source.type;
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

export function showFingerprintDiff(
  diff: FingerprintDiffItem[],
  platform: string,
): void {
  if (diff.length === 0) {
    return;
  }

  p.log.info(`${colors.bold(`${platform} Fingerprint Changes:`)}`);

  const added = diff.filter((item) => item.op === "added");
  const removed = diff.filter((item) => item.op === "removed");
  const changed = diff.filter((item) => item.op === "changed");

  if (added.length > 0) {
    p.log.info(
      `  ${colors.green("Added:")} ${added.map((item) => getSourcePath(item.addedSource)).join(", ")}`,
    );
  }

  if (removed.length > 0) {
    p.log.info(
      `  ${colors.red("Removed:")} ${removed.map((item) => getSourcePath(item.removedSource)).join(", ")}`,
    );
  }

  if (changed.length > 0) {
    p.log.info(
      `  ${colors.yellow("Changed:")} ${changed.map((item) => getSourcePath(item.beforeSource)).join(", ")}`,
    );
  }
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
