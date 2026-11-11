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
 * How a built or imported `.ipa` was exported, from its embedded
 * provisioning profile, which decides it whatever the export options asked:
 * a device list is ad hoc, or development with `get-task-allow`; every
 * device is enterprise; neither is an App Store export. Null when no profile
 * says so, one missing or unreadable, which the registry records as
 * unknown.
 */
export const readIpaExportMethod = async (
  artifactPath: string,
): Promise<NativeBuildExportMethod | null> => {
  try {
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
  } catch {
    return null;
  }
};
