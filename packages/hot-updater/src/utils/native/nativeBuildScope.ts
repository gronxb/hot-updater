import { fitText, getCwd, type loadConfig, p } from "@hot-updater/cli-tools";
import type { NativeBuildScope, Platform } from "@hot-updater/plugin-core";
import {
  isSandboxChannel,
  sandboxChannelOf,
} from "@hot-updater/protocol/native-artifact";

import { generateFingerprint } from "../fingerprint";
import { getChannel } from "../setChannel";
import {
  formatAppVersionCandidates,
  isAmbiguousAppVersion,
} from "../version/appVersionCandidates";
import { resolveNativeAppVersion } from "../version/getNativeAppVersion";
import { nativeBuildAppVersionScope } from "./appVersionScope";

/**
 * What a build of the project would embed, read without writing the native
 * projects: a lookup must not rewrite them, as the build adapter's prebuild
 * (such as `expo prebuild`) would. The adapter reports what its prebuild
 * would write; anything else is read from the native projects as they are.
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
  // A sandbox build's channel comes from its scheme, whatever the project says.
  if (schemeConfig?.sandbox) {
    const reserved = sandboxChannelOf(scheme!);
    if (channel !== undefined && channel !== reserved) {
      throw new Error(
        `The sandbox scheme ${scheme} builds channel ${reserved}, not ${channel}.\nRemove --channel.`,
      );
    }
  } else if (
    scheme !== undefined &&
    channel !== undefined &&
    isSandboxChannel(channel)
  ) {
    throw new Error(
      `Channel ${channel} is reserved for sandbox builds, and the scheme ${scheme} isn't one.\nPass another --channel.`,
    );
  }
  const buildChannel = schemeConfig?.sandbox
    ? sandboxChannelOf(scheme!)
    : (channel ?? prebuildValues.channel ?? (await getChannel(platform)).value);
  if (config.updateStrategy === "fingerprint") {
    // From the config's fingerprint inputs, as a build writes fingerprint.json
    // and deploy targets, whatever the committed fingerprint.json records.
    const { hash } = await generateFingerprint(platform);
    return {
      platform,
      channel: buildChannel,
      fingerprintHash: hash,
      appVersion: null,
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
  };
};
