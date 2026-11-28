import path from "path";

import { execa } from "execa";

/**
 * Makes a built app embed `channel`: its Info.plist's `HOT_UPDATER_CHANNEL`,
 * which the SDK reads, whatever the project's Info.plist or an Expo config
 * plugin set. The app's signature covers the Info.plist, so an archived app
 * is stamped before its export signs it, and a simulator app is signed again
 * ad hoc after, as Xcode does for the simulator.
 */
export const stampAppChannel = async (
  appPath: string,
  channel: string,
  { signAdHoc = false }: { readonly signAdHoc?: boolean } = {},
): Promise<void> => {
  await execa("plutil", [
    "-replace",
    "HOT_UPDATER_CHANNEL",
    "-string",
    channel,
    path.join(appPath, "Info.plist"),
  ]);
  if (signAdHoc) {
    await execa("codesign", [
      "--force",
      "--sign",
      "-",
      "--timestamp=none",
      "--preserve-metadata=entitlements",
      appPath,
    ]);
  }
};
