import fs from "fs";

import { p } from "@hot-updater/cli-tools";
import {
  blobSource,
  normalizeIosUdid,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";

/**
 * Says which devices a built `.ipa` installs on, from the `.ipa` itself: only
 * its bytes decide, whatever the Apple account lists. With `udids` it says
 * whether each is in, and a missing one fails the run, since the person passed
 * it to get a build that has it. An App Store export lists no devices, which is
 * news only to someone who passed a UDID. Registering a device reaches an `.ipa`
 * only when its export gets a new profile, which a CI runner always does, and a
 * machine that keeps a saved profile doesn't, while that profile fits.
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
    ? await (async () =>
        readIpaInstallInfo(
          blobSource(await fs.openAsBlob(artifactPath)),
        ))().catch(() => null)
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
        [
          `${udid} isn't in this .ipa.`,
          `If native-build devices list --scheme ${scheme} shows it, Xcode reused a profile saved on this machine. Delete this app's ad hoc profile from ~/Library/Developer/Xcode/UserData/Provisioning Profiles, and build again.`,
        ].join("\n"),
      );
      process.exitCode = 1;
    }
  }
};
