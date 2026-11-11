import fs from "fs";

import {
  blobSource,
  type IpaInstallInfo,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";

/**
 * How an exported `.ipa` is signed: its distribution, team, the devices its
 * profiles list, and the bundle IDs they are for. Null for one it can't read.
 */
export const readIpaSigning = async (
  ipaPath: string,
): Promise<IpaInstallInfo | null> => {
  try {
    return await readIpaInstallInfo(blobSource(await fs.openAsBlob(ipaPath)));
  } catch {
    return null;
  }
};
