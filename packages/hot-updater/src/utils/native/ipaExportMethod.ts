import fs from "fs";

import type { NativeBuildExportMethod } from "@hot-updater/plugin-core";
import {
  blobSource,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";

/**
 * How a built or imported `.ipa` was exported, from its embedded
 * provisioning profile, which decides it whatever the export options asked:
 * a device list is ad hoc, or development with `get-task-allow`; every
 * device is enterprise; neither is an App Store export. Null when the
 * profile can't be read, which the registry records as unknown.
 */
export const readIpaExportMethod = async (
  artifactPath: string,
): Promise<NativeBuildExportMethod | null> => {
  try {
    const { distribution } = await readIpaInstallInfo(
      blobSource(await fs.openAsBlob(artifactPath)),
    );
    return distribution === "store" ? "app-store" : distribution;
  } catch {
    return null;
  }
};
