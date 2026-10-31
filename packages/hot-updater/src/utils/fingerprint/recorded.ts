import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  fitText,
  getCwd,
  reactNativeCliFingerprint,
} from "@hot-updater/cli-tools";
import type {
  NativeFingerprint,
  NativeFingerprintOptions,
  Platform,
} from "@hot-updater/plugin-core";

import { DEFAULT_FINGERPRINT_ADAPTER, type FingerprintInputs } from "./common";

/**
 * The official build adapters whose fingerprint a native build computes from
 * fingerprint.json alone: the package and the export that computes it.
 */
const ADAPTER_FINGERPRINTS: Readonly<
  Record<string, { readonly packageName: string; readonly exportName: string }>
> = {
  bare: { packageName: "@hot-updater/bare", exportName: "bareFingerprint" },
  rock: { packageName: "@hot-updater/rock", exportName: "rockFingerprint" },
  expo: { packageName: "@hot-updater/expo", exportName: "expoFingerprint" },
};

type AdapterFingerprint = (
  cwd: string,
  options: NativeFingerprintOptions,
) => Promise<NativeFingerprint>;

const loadAdapterFingerprint = async (
  cwd: string,
  { packageName, exportName }: (typeof ADAPTER_FINGERPRINTS)[string],
): Promise<AdapterFingerprint | "missing" | null> => {
  let entry: string;
  try {
    entry = createRequire(path.join(cwd, "package.json")).resolve(packageName);
  } catch {
    return "missing";
  }
  const module = (await import(pathToFileURL(entry).href)) as Record<
    string,
    unknown
  > & { default?: Record<string, unknown> };
  const fingerprint = module[exportName] ?? module.default?.[exportName];
  return typeof fingerprint === "function"
    ? (fingerprint as AdapterFingerprint)
    : null;
};

/**
 * The fingerprint a native build of `platform` embeds, computed from the
 * inputs fingerprint.json records instead of hot-updater.config.ts, whose
 * storage and database need deploy secrets a build machine may not have.
 * `recorded` is the hash fingerprint.json holds for the platform.
 */
export const computeRecordedFingerprintHash = async (
  platform: Platform,
): Promise<{ hash: string; recorded: string | null }> => {
  const cwd = getCwd();
  let file: {
    ios?: { hash?: string };
    android?: { hash?: string };
    inputs?: FingerprintInputs;
  };
  try {
    file = JSON.parse(
      await fs.readFile(path.join(cwd, "fingerprint.json"), "utf8"),
    );
  } catch {
    throw new Error(
      "fingerprint.json was not found. Run `npx hot-updater fingerprint create`.",
    );
  }
  const recorded = file[platform]?.hash ?? null;
  const embedRecorded = (reason: string) => {
    if (recorded === null) {
      throw new Error(
        `fingerprint.json has no ${platform} fingerprint. Run \`npx hot-updater fingerprint create\`.`,
      );
    }
    console.error(fitText(`warning: ${reason} The build embeds ${recorded}.`));
    return { hash: recorded, recorded };
  };

  const inputs = file.inputs;
  if (!inputs) {
    return embedRecorded(
      "fingerprint.json records no inputs to compute the fingerprint from. Run `npx hot-updater fingerprint create`.",
    );
  }
  const options: NativeFingerprintOptions = {
    platform,
    ...(inputs.extraSources === undefined
      ? {}
      : { extraSources: inputs.extraSources }),
    ...(inputs.ignorePaths === undefined
      ? {}
      : { ignorePaths: inputs.ignorePaths }),
    ...(inputs.nativeVersion === undefined
      ? {}
      : { nativeVersion: inputs.nativeVersion }),
  };
  const adapter = ADAPTER_FINGERPRINTS[inputs.adapter];
  if (adapter) {
    const fingerprint = await loadAdapterFingerprint(cwd, adapter);
    if (fingerprint === "missing") {
      return embedRecorded(
        `fingerprint.json records the ${inputs.adapter} build adapter, but ${adapter.packageName} is not installed. Run \`npx hot-updater fingerprint create\`.`,
      );
    }
    if (!fingerprint) {
      return embedRecorded(
        `The installed ${adapter.packageName} does not export ${adapter.exportName}; update it to compute the fingerprint at build time.`,
      );
    }
    return { hash: (await fingerprint(cwd, options)).hash, recorded };
  }
  if (inputs.adapter === DEFAULT_FINGERPRINT_ADAPTER) {
    return {
      hash: (await reactNativeCliFingerprint(cwd, options)).hash,
      recorded,
    };
  }
  return embedRecorded(
    `The "${inputs.adapter}" build adapter's fingerprint needs hot-updater.config.ts.`,
  );
};
