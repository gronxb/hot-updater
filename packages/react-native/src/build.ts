import fs from "node:fs/promises";
import path from "node:path";

import {
  type BuildArtifact,
  compareStringsByCodeUnit,
  type Platform,
} from "@hot-updater/plugin-core";

export { createReactNativeFingerprint } from "./buildFingerprint";

export interface ReactNativeArtifactSelection {
  artifacts: BuildArtifact[];
  patchAssetPath: string;
}

const toPosix = (value: string) => value.split(path.sep).join("/");

/**
 * Applies React Native's Metro/Hermes artifact policy at its integration edge.
 */
export async function selectReactNativeArtifacts({
  buildPath,
  platform,
}: {
  buildPath: string;
  platform: Platform;
}): Promise<ReactNativeArtifactSelection> {
  const names = await fs.readdir(buildPath, { recursive: true });
  const files: string[] = [];
  for (const name of names) {
    const filePath = path.join(buildPath, name);
    if ((await fs.lstat(filePath)).isFile()) files.push(toPosix(name));
  }

  const bundleCandidates = new Map<string, string>();
  const selected = new Map<string, string>();
  for (const name of files) {
    if (name.endsWith(".map")) continue;
    if (name.endsWith(".bundle") || name.endsWith(".bundle.hbc")) {
      const finalName = name.endsWith(".bundle.hbc") ? name.slice(0, -4) : name;
      const existing = bundleCandidates.get(finalName);
      if (!existing || (!existing.endsWith(".hbc") && name.endsWith(".hbc"))) {
        bundleCandidates.set(finalName, name);
      }
    } else {
      selected.set(name, name);
    }
  }
  for (const [finalName, sourceName] of bundleCandidates) {
    selected.set(finalName, sourceName);
  }

  const patchAssetPath = `index.${platform}.bundle`;
  if (!selected.has(patchAssetPath)) {
    throw new Error(
      `React Native build did not produce ${patchAssetPath} or its Hermes bytecode.`,
    );
  }

  const artifacts = [...selected]
    .sort(([left], [right]) => compareStringsByCodeUnit(left, right))
    .map(
      ([name, sourceName]): BuildArtifact => ({
        path: path.join(buildPath, sourceName),
        name,
        downloadCompression: /(^|\/)index\.[^/]+\.bundle$/.test(name)
          ? "br"
          : null,
      }),
    );

  return { artifacts, patchAssetPath };
}
