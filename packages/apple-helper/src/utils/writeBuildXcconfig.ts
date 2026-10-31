import fs from "fs";
import path from "path";

const SDK_CONDITIONS = ["", "[sdk=iphoneos*]", "[sdk=iphonesimulator*]"];

/**
 * Finds a setting of `keys` that an included xcconfig sets with a condition
 * the build xcconfig does not, such as `[config=Release]` or `[arch=arm64]`,
 * which would outrank the build's own. It follows `#include`s, which are
 * relative to the including file.
 */
const findConditionalSetting = async (
  files: string[],
  keys: string[],
  visited = new Set<string>(),
): Promise<string | undefined> => {
  for (const file of files) {
    if (visited.has(file) || !fs.existsSync(file)) {
      continue;
    }
    visited.add(file);
    const lines = (await fs.promises.readFile(file, "utf-8")).split("\n");
    for (const [index, line] of lines.entries()) {
      const include = line.match(/^\s*#include\??\s*"([^"]+)"/)?.[1];
      if (include) {
        const found = await findConditionalSetting(
          [path.resolve(path.dirname(file), include)],
          keys,
          visited,
        );
        if (found) {
          return found;
        }
        continue;
      }
      const [, key, conditions] =
        line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)((?:\[[^\]]*\])+)\s*=/) ?? [];
      if (key && keys.includes(key) && !SDK_CONDITIONS.includes(conditions!)) {
        return `${file}:${index + 1} sets ${key}${conditions}`;
      }
    }
  }
  return undefined;
};

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

  const includedFiles = included.map((file) => path.resolve(sourceDir, file));
  const conditional = await findConditionalSetting(
    includedFiles,
    Object.keys(settings),
  );
  if (conditional) {
    throw new Error(
      `${conditional}, which would outrank the value the build sets. Set it without that condition, or remove it.`,
    );
  }

  const buildXcconfig = path.join(directory, "HotUpdater.xcconfig");
  await fs.promises.writeFile(
    buildXcconfig,
    [
      ...includedFiles.map((file) => `#include "${file}"`),
      // A matching SDK condition outranks the unconditional setting, so
      // each is set for the device and simulator SDKs too.
      ...Object.entries(settings).flatMap(([key, value]) =>
        SDK_CONDITIONS.map((condition) => `${key}${condition} = ${value}`),
      ),
      "",
    ].join("\n"),
  );
  return { xcconfig: buildXcconfig, extraParams: otherParams };
};

/**
 * Automatic signing over a target set to manual signing, whose provisioning
 * profile and identity Xcode would otherwise report as conflicting.
 */
const AUTOMATIC_SIGNING = {
  CODE_SIGN_STYLE: "Automatic",
  PROVISIONING_PROFILE: "",
  PROVISIONING_PROFILE_SPECIFIER: "",
  CODE_SIGN_IDENTITY: "Apple Development",
};

/**
 * Brings back the sandbox layer's sources, which the podspec's
 * `EXCLUDED_SOURCE_FILE_NAMES` leaves out of every other build.
 */
const SANDBOX_SOURCES = { INCLUDED_SOURCE_FILE_NAMES: "HotUpdaterSandbox*" };

/**
 * The settings a build sets over the scheme's: the MIN_BUNDLE_ID the CLI
 * issues and reports, automatic signing when an App Store Connect API key
 * signs, which a target set to manual signing would not use, and the sandbox
 * layer's sources for a sandbox scheme.
 */
export const buildSettingsOverScheme = ({
  minBundleId,
  authenticationArgs,
  sandbox = false,
}: {
  minBundleId: string;
  authenticationArgs?: string[];
  sandbox?: boolean;
}): Record<string, string> => ({
  HOT_UPDATER_MIN_BUNDLE_ID: minBundleId,
  ...(authenticationArgs ? AUTOMATIC_SIGNING : {}),
  ...(sandbox ? SANDBOX_SOURCES : {}),
});
