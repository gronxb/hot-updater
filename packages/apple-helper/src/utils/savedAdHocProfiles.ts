import fs from "fs";
import os from "os";
import path from "path";

import { readProvisioningProfile } from "@hot-updater/protocol/native-artifact";

/**
 * Where Xcode and the system keep the provisioning profiles a Mac has saved:
 * older Xcode in `MobileDevice`, Xcode 16 and later in its `UserData`.
 */
export const provisioningProfileDirs = (home: string = os.homedir()) => [
  path.join(home, "Library", "MobileDevice", "Provisioning Profiles"),
  path.join(
    home,
    "Library",
    "Developer",
    "Xcode",
    "UserData",
    "Provisioning Profiles",
  ),
];

const PROFILE_FILE = /\.(?:mobileprovision|provisionprofile)$/u;

/** What deleting saved profiles came to. */
export interface SavedAdHocProfileRemoval {
  /** The UUIDs, or file names, of the profiles deleted. */
  readonly removed: readonly string[];
  /** Profiles that matched but couldn't be deleted, with why. */
  readonly failed: readonly {
    readonly file: string;
    readonly reason: string;
  }[];
}

/**
 * Deletes the ad hoc profiles Xcode made and saved on this Mac for one app's
 * bundle IDs in one team, so its next export asks Apple for a new one, which
 * lists every device the account has enabled now. A profile goes only when all
 * of these hold: Xcode manages it (`IsXcodeManaged`), it is an ad hoc profile,
 * its team is `teamId`, and its `application-identifier` is `<teamId>.<one of
 * bundleIds>`. A manual or development profile, another team's, and another
 * app's always stay. A file it can't read stays too.
 */
export const removeSavedAdHocProfiles = async ({
  teamId,
  bundleIds,
  dirs = provisioningProfileDirs(),
}: {
  readonly teamId: string;
  readonly bundleIds: readonly string[];
  readonly dirs?: readonly string[];
}): Promise<SavedAdHocProfileRemoval> => {
  const applicationIds = new Set(
    bundleIds.map((bundleId) => `${teamId}.${bundleId}`),
  );
  const removed: string[] = [];
  const failed: { file: string; reason: string }[] = [];
  for (const dir of dirs) {
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!PROFILE_FILE.test(name)) continue;
      const file = path.join(dir, name);
      let profile: ReturnType<typeof readProvisioningProfile>;
      try {
        profile = readProvisioningProfile(await fs.promises.readFile(file));
      } catch {
        continue;
      }
      if (
        !profile.xcodeManaged ||
        profile.distribution !== "ad-hoc" ||
        profile.teamId !== teamId ||
        profile.applicationIdentifier === null ||
        !applicationIds.has(profile.applicationIdentifier)
      ) {
        continue;
      }
      try {
        await fs.promises.rm(file);
        removed.push(profile.uuid ?? name);
      } catch (error) {
        failed.push({
          file,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { removed, failed };
};
