import * as p from "@clack/prompts";
import type { FingerprintDiffItem, FingerprintSource } from "@expo/fingerprint";
import { diffFingerprintChangesAsync } from "@expo/fingerprint";
import { getCwd } from "@hot-updater/plugin-core";
import picocolors from "picocolors";
import {
  type FingerprintOptions,
  type FingerprintResult,
  getFingerprintOptions,
} from "./common";

export async function getFingerprintDiff(
  oldFingerprint: FingerprintResult,
  options: FingerprintOptions,
): Promise<FingerprintDiffItem[]> {
  const projectPath = getCwd();
  return await diffFingerprintChangesAsync(
    oldFingerprint,
    projectPath,
    getFingerprintOptions(options.platform, projectPath, options),
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
    added: picocolors.green,
    removed: picocolors.red,
    changed: picocolors.yellow,
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

  p.log.info(`${picocolors.bold(`${platform} Fingerprint Changes:`)}`);

  const added = diff.filter((item) => item.op === "added");
  const removed = diff.filter((item) => item.op === "removed");
  const changed = diff.filter((item) => item.op === "changed");

  if (added.length > 0) {
    p.log.info(
      `  ${picocolors.green("Added:")} ${added.map((item) => getSourcePath(item.addedSource)).join(", ")}`,
    );
  }

  if (removed.length > 0) {
    p.log.info(
      `  ${picocolors.red("Removed:")} ${removed.map((item) => getSourcePath(item.removedSource)).join(", ")}`,
    );
  }

  if (changed.length > 0) {
    p.log.info(
      `  ${picocolors.yellow("Changed:")} ${changed.map((item) => getSourcePath(item.beforeSource)).join(", ")}`,
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
