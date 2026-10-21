import { colors, loadConfig, p } from "@hot-updater/cli-tools";
import type {
  NativeBuildRow,
  NativeBuildScope,
  Platform,
} from "@hot-updater/plugin-core";

import { ui } from "../utils/cli-ui";
import { generateFingerprint } from "../utils/fingerprint";
import { loadServer } from "../utils/loadServer";
import { nativeBuildAppVersionScope } from "../utils/native/appVersionScope";
import { printBanner } from "../utils/printBanner";
import { getChannel } from "../utils/setChannel";
import {
  formatAppVersionCandidates,
  isAmbiguousAppVersion,
} from "../utils/version/appVersionCandidates";
import { resolveNativeAppVersion } from "../utils/version/getNativeAppVersion";
import { safeDispose } from "./release";

export interface NativeBuildFindOptions {
  readonly platform: Platform;
  /** The channel the build embeds (default: the native project's). */
  readonly channel?: string;
  /** The `nativeBuild` scheme, whose app's version the build would have. */
  readonly scheme?: string;
  readonly json?: boolean;
}

/**
 * Finds the newest registered native build that a build of the project
 * would match, as a pull request's preview job does before deciding whether
 * to build: the fingerprint the build would embed, or with the appVersion
 * strategy, the version of the app its scheme builds, on the channel it
 * would embed. Printing no build is a result, not a failure.
 */
export const handleNativeBuildFind = async (
  options: NativeBuildFindOptions,
) => {
  if (!options.json) printBanner();
  try {
    const config = await loadConfig(null, { credentials: true });
    if (
      options.scheme !== undefined &&
      !(options.scheme in config.nativeBuild[options.platform])
    ) {
      throw new Error(
        `scheme ${colors.blueBright(options.scheme)} is not in nativeBuild.${options.platform} in hot-updater.config.ts.`,
      );
    }
    const scope = await resolveScope(config, options);

    const server = await loadServer(config);
    let nativeBuild: NativeBuildRow | null;
    try {
      nativeBuild = await server.core.findNativeBuild(scope);
    } finally {
      await safeDispose(server);
    }

    if (options.json) {
      console.log(JSON.stringify({ ...scope, nativeBuild }, null, 2));
      return;
    }
    const target =
      scope.fingerprintHash === null
        ? ui.kv("App version", ui.version(scope.appVersion))
        : ui.kv("Fingerprint", ui.id(scope.fingerprintHash));
    if (nativeBuild === null) {
      console.log(
        ui.block("No native build", [
          ui.kv("Platform", ui.platform(scope.platform)),
          ui.kv("Channel", ui.channel(scope.channel)),
          target,
        ]),
      );
      return;
    }
    console.log(
      ui.block("Native build", [
        ui.kv("ID", ui.id(nativeBuild.id)),
        ui.kv("Platform", ui.platform(scope.platform)),
        ui.kv("Channel", ui.channel(scope.channel)),
        target,
        ui.kv("Kind", nativeBuild.artifact_kind),
        ui.kv("Min bundle ID", ui.id(nativeBuild.min_bundle_id)),
        ui.kv("Created", new Date(nativeBuild.created_at_ms).toISOString()),
      ]),
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

const resolveScope = async (
  config: Awaited<ReturnType<typeof loadConfig>>,
  { platform, channel, scheme }: NativeBuildFindOptions,
): Promise<NativeBuildScope> => {
  const buildChannel = channel ?? (await getChannel(platform)).value;
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
  const resolved = await resolveNativeAppVersion(
    platform,
    scheme === undefined ? {} : nativeBuildAppVersionScope(config, scheme),
  );
  if (!resolved.version) {
    throw new Error(
      isAmbiguousAppVersion(resolved)
        ? `The native project builds several app versions (${formatAppVersionCandidates(resolved.candidates)}). Pass --scheme with the nativeBuild scheme that builds the app.`
        : `Failed to retrieve native app version of ${platform}`,
    );
  }
  return {
    platform,
    channel: buildChannel,
    fingerprintHash: null,
    appVersion: resolved.version,
  };
};
