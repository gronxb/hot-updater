import fs from "node:fs";
import path from "node:path";

import { formatDuration } from "@hot-updater/cli-tools";

import { ui } from "../cli-ui";
import { formatBytes } from "../formatBytes";
import type {
  NativeBuildArtifactKind,
  NativeBuildResult,
} from "./createNativeBuild";

/** The widest a summary's row is, after clack's 3-column gutter. */
const LINE_WIDTH = 77;

const KIND_LABELS: Record<NativeBuildArtifactKind, string> = {
  ipa: "IPA",
  app: "App",
  aab: "AAB",
  apk: "APK",
};

/** What `native-build` prints last of a build, built or reused. */
export interface NativeBuildSummary {
  /** `iOS` or `Android`. */
  readonly platformName: string;
  readonly result: NativeBuildResult;
  /** Whether a cached build was reused instead of built. */
  readonly reused: boolean;
  /** From the preparation's start. */
  readonly elapsedMs: number;
  /** The artifact's size, or null when it can't be read. */
  readonly byteSize: number | null;
  /** The build log, or null for a reused build or without one. */
  readonly logFilePath: string | null;
  /** The store's page of the submitted build, such as TestFlight's. */
  readonly storeUrl?: string;
}

/**
 * The summary, a `ui.block` for `p.log.success`: what was built, with its
 * version and build number, in how long, then the artifact with its size,
 * what it selects updates by, and its log.
 *
 * ```
 * iOS release 1.7.0 (42) built in 8m30s
 * IPA            .hot-updater/build/ios/release/CodexRelay.ipa · 48.0 MB
 * Min bundle ID  0199c2d4-…
 * Channel        production
 * Log            .hot-updater/log/10291132-ios-release-build.log
 * ```
 */
export const formatNativeBuildSummary = ({
  platformName,
  result,
  reused,
  elapsedMs,
  byteSize,
  logFilePath,
  storeUrl,
}: NativeBuildSummary): string => {
  const heading = [
    platformName,
    result.scheme,
    result.appVersion,
    result.buildNumber ? `(${result.buildNumber})` : null,
    `${reused ? "reused" : "built"} in ${formatDuration(elapsedMs)}`,
  ]
    .filter(Boolean)
    .join(" ");
  const kind = KIND_LABELS[result.artifactKind];
  const labels = [
    kind,
    result.fingerprintHash !== null && "Fingerprint",
    "Min bundle ID",
    "Channel",
    storeUrl && "Open",
    logFilePath && "Log",
  ].filter((label): label is string => Boolean(label));
  // ui.block pads each label to the widest plus two spaces.
  const pathWidth = LINE_WIDTH - Math.max(...labels.map((l) => l.length)) - 2;
  const size = byteSize === null ? "" : ` · ${formatBytes(byteSize)}`;
  return ui.block(heading, [
    ui.kv(
      kind,
      `${ui.fitPath(result.artifactPath, pathWidth - size.length)}${ui.muted(size)}`,
    ),
    result.fingerprintHash !== null &&
      ui.kv("Fingerprint", ui.id(result.fingerprintHash)),
    ui.kv("Min bundle ID", ui.id(result.minBundleId)),
    ui.kv("Channel", ui.channel(result.channel)),
    // A URL is never shortened: one too long for its row, such as
    // TestFlight's, takes a line of its own.
    storeUrl !== undefined &&
      (storeUrl.length <= pathWidth ? ui.kv("Open", storeUrl) : storeUrl),
    logFilePath !== null &&
      ui.kv("Log", ui.path(ui.fitPath(logFilePath, pathWidth))),
  ]);
};

/**
 * The artifact's size: the file's, or the sum of a directory's files, such
 * as a simulator `.app`'s; null when it can't be read.
 */
export const readArtifactSize = async (
  artifactPath: string,
): Promise<number | null> => {
  try {
    const stat = await fs.promises.stat(artifactPath);
    if (!stat.isDirectory()) return stat.size;
    const entries = await fs.promises.readdir(artifactPath, {
      recursive: true,
      withFileTypes: true,
    });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      total += (await fs.promises.stat(path.join(entry.parentPath, entry.name)))
        .size;
    }
    return total;
  } catch {
    return null;
  }
};
