import fs from "fs";

import type { NativeBuildExportMethod } from "@hot-updater/plugin-core";
import {
  blobSource,
  findZipEntry,
  readIpaInstallInfo,
  readZipDirectory,
} from "@hot-updater/protocol/native-artifact";

/** The app's Info.plist, which names the app's directory. */
const APP_INFO_PLIST = /^Payload\/[^/]+\.app\/Info\.plist$/u;

/**
 * An export options `method` as the registry names it: Xcode's current
 * names and its older ones; null for a method that exports no `.ipa` of
 * these kinds.
 */
const EXPORT_OPTIONS_METHODS: Readonly<
  Record<string, NativeBuildExportMethod>
> = {
  "app-store-connect": "app-store",
  "app-store": "app-store",
  "release-testing": "ad-hoc",
  "ad-hoc": "ad-hoc",
  debugging: "development",
  development: "development",
  enterprise: "enterprise",
};

/** How the profile an `.ipa` embeds lets it install, or null with none. */
const readProfileMethod = async (
  artifactPath: string,
): Promise<NativeBuildExportMethod | null> => {
  const source = blobSource(await fs.openAsBlob(artifactPath));
  const entries = await readZipDirectory(source);
  const infoPlist = entries.find(({ name }) => APP_INFO_PLIST.test(name));
  // The install reader takes no profile for an App Store one; only a
  // profile proves how the .ipa was exported.
  if (
    infoPlist === undefined ||
    findZipEntry(
      entries,
      `${infoPlist.name.slice(0, -"Info.plist".length)}embedded.mobileprovision`,
    ) === undefined
  ) {
    return null;
  }
  const { distribution } = await readIpaInstallInfo(source);
  return distribution === "store" ? "app-store" : distribution;
};

/**
 * How a built `.ipa` was exported: the `method` of the export options the
 * build exported it with, when the provisioning profile the `.ipa` embeds
 * confirms it. A device list is ad hoc, or development with
 * `get-task-allow`; every device is enterprise; neither is an App Store
 * export. Null when either is missing, as an imported `.ipa` has no export
 * options, when the profile can't be read, or when they disagree: the
 * registry records it as unknown.
 */
export const readIpaExportMethod = async (
  artifactPath: string,
  exportOptionsMethod: string | null,
): Promise<NativeBuildExportMethod | null> => {
  const method =
    exportOptionsMethod === null
      ? undefined
      : EXPORT_OPTIONS_METHODS[exportOptionsMethod];
  if (method === undefined) return null;
  try {
    return (await readProfileMethod(artifactPath)) === method ? method : null;
  } catch {
    return null;
  }
};
