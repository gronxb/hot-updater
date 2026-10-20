import fs from "fs";
import path from "path";

import { execa } from "execa";

import { createRandomTmpDir } from "./createRandomTmpDir";
import { escapeUnzipPattern } from "./escapeUnzipPattern";

/** What App Store Connect files an `.ipa` under, from its app's Info.plist. */
export interface IpaInfo {
  /** `CFBundleIdentifier`, the App Store Connect app's bundle ID. */
  bundleId: string;
  /** `CFBundleShortVersionString`, the version train. */
  shortVersion: string;
  /** `CFBundleVersion`, the build number, unique within the train. */
  bundleVersion: string;
}

const INFO_PLIST_KEYS = {
  bundleId: "CFBundleIdentifier",
  shortVersion: "CFBundleShortVersionString",
  bundleVersion: "CFBundleVersion",
} as const satisfies Record<keyof IpaInfo, string>;

/**
 * Reads the app's `Payload/<App>.app/Info.plist` out of an `.ipa`, never a
 * framework's or an extension's, which nest deeper.
 */
export const readIpaInfo = async (ipaPath: string): Promise<IpaInfo> => {
  const { stdout } = await execa("unzip", ["-Z1", ipaPath]);
  const entry = stdout
    .split("\n")
    .map((name) => name.trim())
    .find((name) => /^Payload\/[^/]+\.app\/Info\.plist$/u.test(name));
  if (entry === undefined) {
    throw new Error(
      `${path.basename(ipaPath)} has no Payload/<App>.app/Info.plist.`,
    );
  }

  const directory = await createRandomTmpDir();
  try {
    const infoPlist = path.join(directory, "Info.plist");
    await execa("unzip", ["-p", ipaPath, escapeUnzipPattern(entry)], {
      stdout: { file: infoPlist },
    });
    const info = {} as IpaInfo;
    for (const [field, key] of Object.entries(INFO_PLIST_KEYS)) {
      const { stdout: value, exitCode } = await execa(
        "plutil",
        ["-extract", key, "raw", "-o", "-", infoPlist],
        { reject: false },
      );
      if (exitCode !== 0 || !value.trim()) {
        throw new Error(
          `${path.basename(ipaPath)}'s Info.plist has no ${key}.`,
        );
      }
      info[field as keyof IpaInfo] = value.trim();
    }
    return info;
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
