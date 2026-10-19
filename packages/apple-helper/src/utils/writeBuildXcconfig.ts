import fs from "fs";
import path from "path";

/**
 * Writes the xcconfig a build loads, which sets the CLI's build settings
 * over every other. xcodebuild ranks an `-xcconfig`'s settings above the
 * command line's, so the scheme's `xcconfig` and each `-xcconfig` in
 * `extraParams` are included, in order, before `settings`, and the build
 * loads only this one.
 */
export const writeBuildXcconfig = async ({
  directory,
  sourceDir,
  xcconfig,
  extraParams = [],
  settings,
}: {
  directory: string;
  /** The directory xcodebuild runs in, which xcconfig paths are relative to. */
  sourceDir: string;
  xcconfig?: string;
  extraParams?: string[];
  settings: Record<string, string>;
}): Promise<{ xcconfig: string; extraParams: string[] }> => {
  const included = xcconfig ? [xcconfig] : [];
  const otherParams: string[] = [];
  for (let i = 0; i < extraParams.length; i++) {
    if (extraParams[i] === "-xcconfig" && i + 1 < extraParams.length) {
      included.push(extraParams[++i]!);
    } else {
      otherParams.push(extraParams[i]!);
    }
  }

  const buildXcconfig = path.join(directory, "HotUpdater.xcconfig");
  await fs.promises.writeFile(
    buildXcconfig,
    [
      ...included.map((file) => `#include "${path.resolve(sourceDir, file)}"`),
      ...Object.entries(settings).map(([key, value]) => `${key} = ${value}`),
      "",
    ].join("\n"),
  );
  return { xcconfig: buildXcconfig, extraParams: otherParams };
};

/**
 * Automatic signing over a target set to manual signing, whose provisioning
 * profile and identity Xcode would otherwise report as conflicting. Projects
 * also set them for device SDKs only, as React Native's template does.
 */
const AUTOMATIC_SIGNING = {
  CODE_SIGN_STYLE: "Automatic",
  PROVISIONING_PROFILE: "",
  PROVISIONING_PROFILE_SPECIFIER: "",
  "PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]": "",
  CODE_SIGN_IDENTITY: "Apple Development",
  "CODE_SIGN_IDENTITY[sdk=iphoneos*]": "Apple Development",
};

/**
 * The settings a build sets over the scheme's: the MIN_BUNDLE_ID the CLI
 * issues and reports, and automatic signing when an App Store Connect API
 * key signs, which a target set to manual signing would not use.
 */
export const buildSettingsOverScheme = ({
  minBundleId,
  authenticationArgs,
}: {
  minBundleId: string;
  authenticationArgs?: string[];
}): Record<string, string> => ({
  HOT_UPDATER_MIN_BUNDLE_ID: minBundleId,
  ...(authenticationArgs ? AUTOMATIC_SIGNING : {}),
});
