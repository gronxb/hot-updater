import fs from "fs";
import path from "path";

import {
  type EnrichedNativeBuildAndroidScheme,
  enrichNativeBuildAndroidScheme,
} from "@hot-updater/android-helper";
import {
  type EnrichedNativeBuildIosScheme,
  enrichNativeBuildIosScheme,
} from "@hot-updater/apple-helper";
import {
  type ConfigResponse,
  colors,
  getCwd,
  HotUpdateDirUtil,
  loadConfig,
  p,
} from "@hot-updater/cli-tools";
import type {
  BuildAdapter,
  NativeBuildAndroidScheme,
  NativeBuildIosScheme,
  NativeBuildOptions,
  Platform,
  SecretsAdapter,
} from "@hot-updater/plugin-core";

import {
  createAndInjectFingerprintFiles,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import {
  formatAppVersionCandidates,
  isAmbiguousAppVersion,
} from "@/utils/version/appVersionCandidates";
import { resolveNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { canPrompt } from "../prompt";
import { nativeBuildAppVersionScope } from "./appVersionScope";
import type { NativeBuildTarget } from "./createNativeBuild";

/** The scheme built, as `nativeBuild` in hot-updater.config.ts sets it. */
export type NativeBuildSchemeOptions = {
  /** The scheme's name. */
  scheme: string;
  /** The config's `secrets` adapter, which the scheme's credentials resolve from. */
  secrets: SecretsAdapter;
  /** The config's `cacheDir`, where a key issued for a read-only adapter is written. */
  cacheDir: string | null;
  androidScheme?: NativeBuildAndroidScheme;
  iosScheme?: NativeBuildIosScheme;
};

type PreparedNativeBuildConfig = {
  outputPath: string;
  config: ConfigResponse;
  buildAdapter: BuildAdapter;
  scheme: string;
  target: NativeBuildTarget;
  androidSchemeConfig?: EnrichedNativeBuildAndroidScheme;
  iosSchemeConfig?: EnrichedNativeBuildIosScheme;
};

export async function prepareNativeBuild(
  options: NativeBuildOptions & {
    platform: Platform;
    /**
     * Runs on the scheme, as the config sets it, before the adapter's
     * prebuild writes the native projects, so a check that fails, such as a
     * store upload's, changes nothing.
     */
    beforePrebuild?: (scheme: NativeBuildSchemeOptions) => Promise<void>;
  },
): Promise<PreparedNativeBuildConfig | null> {
  const cwd = getCwd();
  const platform = options.platform;

  if (!options.scheme && !options.interactive) {
    p.log.error("required option '-s, --scheme <scheme>' not specified");
    return null;
  }

  const config = await loadConfig({ platform, channel: "" });
  if (!config) {
    p.log.error("No config found. Please run `hot-updater init` first.");
    return null;
  }

  const availableSchemes: string[] = Object.keys(
    config.nativeBuild[platform],
  ).sort();

  if (!availableSchemes.length) {
    p.log.error(
      `Add a native build scheme under nativeBuild.${platform} in hot-updater.config.ts first.`,
    );
    return null;
  }

  const schemeMessage = "Which scheme do you use to build?";
  if (
    options.scheme === undefined &&
    !canPrompt(
      schemeMessage,
      `Re-run with --scheme <${availableSchemes.join(" | ")}>`,
    )
  ) {
    return null;
  }
  const scheme =
    options.scheme ??
    (await p.select({
      message: schemeMessage,
      options: availableSchemes.map((s) => ({ label: s, value: s })),
    }));

  if (p.isCancel(scheme)) {
    return null;
  }

  if (!(scheme in config.nativeBuild[platform])) {
    p.log.error(
      `scheme ${colors.blueBright(options.scheme)} is not in predefined schemes [${colors.blueBright(availableSchemes.join(", "))}]`,
    );
    return null;
  }

  const iosDeviceScheme =
    platform === "ios" && !config.nativeBuild.ios[scheme]?.simulator
      ? config.nativeBuild.ios[scheme]
      : undefined;
  if (
    iosDeviceScheme &&
    !iosDeviceScheme.exportOptionsPlist &&
    !iosDeviceScheme.signing?.ascApiKey
  ) {
    p.log.error(
      `nativeBuild.ios.${scheme} builds for devices, which exports an .ipa with exportOptionsPlist. Set exportOptionsPlist, or signing.ascApiKey to export for App Store Connect with automatic signing.`,
    );
    return null;
  }

  await options.beforePrebuild?.(
    platform === "ios"
      ? {
          scheme,
          secrets: config.secrets,
          cacheDir: config.cacheDir,
          iosScheme: config.nativeBuild.ios[scheme]!,
        }
      : {
          scheme,
          secrets: config.secrets,
          cacheDir: config.cacheDir,
          androidScheme: config.nativeBuild.android[scheme]!,
        },
  );

  // The adapter's prebuild writes the native projects, such as Expo's
  // `expo prebuild`, so it runs before anything reads them.
  const buildAdapter = await config.build({ cwd });
  await buildAdapter.nativeBuild?.prebuild?.({ platform });

  let target: NativeBuildTarget;

  // calculate fingerprint of the current file state in the native platform directory

  if (config.updateStrategy === "fingerprint") {
    const s = p.spinner();
    const localFingerprint = (await readLocalFingerprint())?.[platform];
    if (!localFingerprint) {
      p.log.warn(
        `Resolving fingerprint for ${platform} failed. Building native will generate it.`,
      );
    }
    s.start(`Fingerprinting (${platform})`);

    // generate fingerprint.json automatically
    const generatedFingerprint = (await createAndInjectFingerprintFiles())
      .fingerprint[platform];

    s.stop(`Fingerprint(${platform}): ${generatedFingerprint.hash}`);

    if (!isFingerprintEquals(localFingerprint, generatedFingerprint)) {
      p.log.info(
        `${colors.blue(`fingerprint.json, ${platform} fingerprint config files`)} have been changed.`,
      );
    }
    target = { fingerprintHash: generatedFingerprint.hash, appVersion: null };
  } else {
    // The native build embeds the hash of any fingerprint.json it finds,
    // and an app with one reports the fingerprint strategy.
    if (fs.existsSync(path.join(cwd, "fingerprint.json"))) {
      p.log.error(
        "fingerprint.json exists, but updateStrategy is 'appVersion'. The native build would embed its fingerprint, and the app would report the fingerprint strategy. Delete fingerprint.json, or run `npx hot-updater doctor --fix`, then build again.",
      );
      return null;
    }
    const s = p.spinner();
    s.start(`Get native app version (${platform})`);

    const iosScheme = config.nativeBuild.ios[scheme];
    const androidScheme = config.nativeBuild.android[scheme];
    const resolved = await resolveNativeAppVersion(
      platform,
      nativeBuildAppVersionScope(config, scheme),
    );
    const appVersion = resolved.version;

    s.stop(`App Version(${platform}): ${appVersion}`);

    if (!appVersion) {
      p.log.error(
        isAmbiguousAppVersion(resolved)
          ? platform === "ios"
            ? `nativeBuild.ios.${scheme} (scheme ${iosScheme?.scheme}, bundleIdentifier ${iosScheme?.bundleIdentifier}) does not pick one of the app targets in project.pbxproj, which declare different versions (${formatAppVersionCandidates(resolved.candidates)}). Make its scheme match the name of the app target it builds.`
            : `nativeBuild.android.${scheme} (variant ${androidScheme?.variant ?? "Release"}) does not pick one of the product flavors that set versionName, which declare different versions (${formatAppVersionCandidates(resolved.candidates)}). Set its variant to the flavor it builds, such as brandARelease.`
          : `Failed to retrieve native app version of ${platform}`,
      );
      return null;
    }
    target = { fingerprintHash: null, appVersion };
  }

  const artifactResultStorePath =
    options.outputPath ??
    path.join(
      HotUpdateDirUtil.getDefaultOutputPath({ cwd }),
      "build",
      platform,
      scheme,
    );

  const resolvedOutputPath = path.isAbsolute(artifactResultStorePath)
    ? artifactResultStorePath
    : path.join(cwd, artifactResultStorePath);

  if (platform === "ios") {
    return {
      outputPath: resolvedOutputPath,
      config,
      buildAdapter,
      scheme,
      target,
      iosSchemeConfig: await enrichNativeBuildIosScheme({
        scheme: config.nativeBuild.ios[scheme]!,
        hotUpdaterSchemeName: scheme,
      }),
    };
  } else if (platform === "android") {
    return {
      outputPath: resolvedOutputPath,
      config,
      buildAdapter,
      scheme,
      target,
      androidSchemeConfig: await enrichNativeBuildAndroidScheme({
        schemeConfig: config.nativeBuild.android[scheme]!,
        hotUpdaterSchemeName: scheme,
      }),
    };
  }

  return null;
}
