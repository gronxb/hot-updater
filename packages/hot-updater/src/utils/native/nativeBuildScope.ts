import path from "path";

import {
  type EnrichedNativeBuildIosScheme,
  exportsForAppStoreConnect,
} from "@hot-updater/apple-helper";
import { fitText, getCwd, type loadConfig, p } from "@hot-updater/cli-tools";
import type {
  NativeBuildSandboxScope,
  NativeBuildScope,
  Platform,
} from "@hot-updater/plugin-core";
import { sandboxUrlSchemeOf } from "@hot-updater/protocol/native-artifact";

import { generateFingerprint } from "../fingerprint";
import { getChannel } from "../setChannel";
import {
  formatAppVersionCandidates,
  isAmbiguousAppVersion,
} from "../version/appVersionCandidates";
import { resolveSandboxApplicationId } from "../version/getAndroidVersion";
import { resolveNativeAppVersion } from "../version/getNativeAppVersion";
import { nativeBuildAppVersionScope } from "./appVersionScope";

/** What a sandbox scope reads of a `nativeBuild` scheme, of either platform. */
interface SandboxSchemeConfig {
  readonly sandbox?: unknown;
  readonly sandboxUrlScheme?: string | null;
  readonly packageName?: string;
  readonly bundleIdentifier?: string;
  readonly aab?: boolean;
  readonly simulator?: boolean;
  readonly variant?: string;
  readonly applicationId?: string;
  readonly appModuleName?: string;
  readonly exportOptionsPlist?: string;
}

/**
 * What a scheme's sandbox build is found by, on any channel, or null for a
 * scheme that isn't a sandbox's: the app ID its artifact reports, the URL
 * scheme it registers, its kind of artifact, and how that installs. Android's
 * application ID is read from the Gradle files as the build makes it; when
 * that differs from the build's, the lookup finds nothing and a build runs.
 */
export const resolveSandboxScope = async (
  platform: Platform,
  schemeConfig: SandboxSchemeConfig | undefined,
): Promise<NativeBuildSandboxScope | null> => {
  if (!schemeConfig?.sandbox) return null;
  if (platform === "android") {
    const scheme = schemeConfig as SandboxSchemeConfig & {
      readonly packageName: string;
    };
    const artifactKind = (scheme.aab ?? true) ? "aab" : "apk";
    return {
      appId: await resolveSandboxApplicationId(scheme),
      urlScheme:
        scheme.sandboxUrlScheme ?? sandboxUrlSchemeOf(scheme.packageName),
      artifactKind,
      distribution: artifactKind === "aab" ? "store" : "direct",
    };
  }
  const scheme = schemeConfig as SandboxSchemeConfig & {
    readonly bundleIdentifier: string;
  };
  const artifactKind = scheme.simulator ? "app" : "ipa";
  const exportOptionsPlist =
    scheme.exportOptionsPlist === undefined
      ? undefined
      : path.resolve(getCwd(), scheme.exportOptionsPlist);
  return {
    appId: scheme.bundleIdentifier,
    urlScheme:
      scheme.sandboxUrlScheme ?? sandboxUrlSchemeOf(scheme.bundleIdentifier),
    artifactKind,
    distribution:
      artifactKind === "ipa" &&
      (await exportsForAppStoreConnect({
        exportOptionsPlist,
      } as EnrichedNativeBuildIosScheme))
        ? "store"
        : "direct",
  };
};

/**
 * What a build of the project would embed, read without writing the native
 * projects: a lookup must not rewrite them, as the build adapter's prebuild
 * (such as `expo prebuild`) would. The adapter reports what its prebuild
 * would write; anything else is read from the native projects as they are.
 * A sandbox scheme's scope also has its `sandbox`, so its lookups find a
 * sandbox build on any channel.
 */
export const resolveNativeBuildScope = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  {
    platform,
    channel,
    scheme,
    json,
  }: {
    readonly platform: Platform;
    /** The channel the build embeds (default: the native project's). */
    readonly channel?: string;
    /** The `nativeBuild` scheme, whose app's version the build has. */
    readonly scheme?: string;
    /** Warnings go to stderr, so stdout stays JSON. */
    readonly json?: boolean;
  },
): Promise<NativeBuildScope> => {
  const buildAdapter = await config.build({ cwd: getCwd() });
  const prebuildValues =
    (await buildAdapter.nativeBuild?.getNativeProjectValues?.({ platform })) ??
    {};
  const schemeConfig =
    scheme === undefined ? undefined : config.nativeBuild[platform][scheme];
  const buildChannel =
    channel ?? prebuildValues.channel ?? (await getChannel(platform)).value;
  const sandbox = await resolveSandboxScope(platform, schemeConfig);
  if (config.updateStrategy === "fingerprint") {
    // From the config's fingerprint inputs, as a build writes fingerprint.json
    // and deploy targets, whatever the committed fingerprint.json records.
    const { hash } = await generateFingerprint(platform);
    return {
      platform,
      channel: buildChannel,
      fingerprintHash: hash,
      appVersion: null,
      ...(sandbox === null ? {} : { sandbox }),
    };
  }
  const versionScope =
    scheme === undefined ? {} : nativeBuildAppVersionScope(config, scheme);
  // The version the prebuild would write stands for the one it overwrites,
  // so a scheme's own version in the native project, such as a product
  // flavor's, still wins, as in the build.
  let resolved = await resolveNativeAppVersion(
    platform,
    versionScope,
    prebuildValues.appVersion,
  );
  const prebuild = buildAdapter.nativeBuild?.prebuild;
  if (!resolved.version && resolved.candidates.length === 0 && prebuild) {
    // No native project declares a version, and the adapter can't say what
    // its prebuild would write: generating the project is the only way left.
    const warning = `No ${platform} native project to read the app version from.\nRunning the ${buildAdapter.name} build adapter's prebuild to write it.`;
    if (json) console.error(fitText(warning));
    else p.log.warn(warning);
    await prebuild({ platform });
    resolved = await resolveNativeAppVersion(platform, versionScope);
  }
  if (!resolved.version) {
    throw new Error(
      isAmbiguousAppVersion(resolved)
        ? [
            "The native project builds several app versions.",
            `Versions: ${formatAppVersionCandidates(resolved.candidates)}`,
            "Pass --scheme with the nativeBuild scheme that builds the app.",
          ].join("\n")
        : `Couldn't read the ${platform} app version.`,
    );
  }
  return {
    platform,
    channel: buildChannel,
    fingerprintHash: null,
    appVersion: resolved.version,
    ...(sandbox === null ? {} : { sandbox }),
  };
};
