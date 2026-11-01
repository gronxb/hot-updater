import fs from "fs";

import { p } from "@hot-updater/cli-tools";
import {
  blobSource,
  normalizeIosUdid,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";

import { ui } from "../cli-ui";

/**
 * Says which devices a built `.ipa` installs on, from the `.ipa` itself: only
 * its bytes decide, whatever the Apple account lists. With `udids` it says
 * whether each is in, and a missing one fails the run, since the person passed
 * it to get a build that has it. An App Store export lists no devices, which is
 * news only to someone who passed a UDID.
 */
export const reportIpaDevices = async ({
  artifactPath,
  scheme,
  udids,
}: {
  artifactPath: string;
  scheme: string;
  udids: readonly string[];
}): Promise<void> => {
  const info = artifactPath.endsWith(".ipa")
    ? await fs
        .openAsBlob(artifactPath)
        .then((blob) => readIpaInstallInfo(blobSource(blob)))
        .catch(() => null)
    : null;
  const listsDevices =
    info?.distribution === "ad-hoc" || info?.distribution === "development";
  if (!listsDevices) {
    if (udids.length > 0 && info?.distribution !== "enterprise") {
      p.log.warn(
        `This build lists no devices, so ${udids.join(", ")} can't install it.\nExport with method release-testing in the scheme's exportOptionsPlist.`,
      );
      process.exitCode = 1;
    }
    return;
  }
  p.log.info(`Devices in this .ipa: ${info.devices.length}`);
  for (const udid of udids) {
    if (info.devices.includes(normalizeIosUdid(udid) ?? udid)) {
      p.log.success(`${udid} included`);
    } else {
      p.log.warn(
        ui.withCommand(
          `${udid} isn't in this .ipa. Check that it's registered:`,
          `npx hot-updater native-build devices list --scheme ${scheme}`,
        ),
      );
      process.exitCode = 1;
    }
  }
};
