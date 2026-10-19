import { buildAndroid } from "@hot-updater/android-helper";
import { buildIos } from "@hot-updater/apple-helper";
import {
  CredentialUnavailableError,
  p,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type { NativeBuildOptions, Platform } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import {
  createNativeBuild,
  type NativeBuildResult,
} from "@/utils/native/createNativeBuild";
import { createMinBundleId } from "@/utils/native/minBundleId";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";
import { getChannel } from "@/utils/setChannel";

import { ui } from "../utils/cli-ui";

const buildNativeInternal = async ({
  options,
  platform,
}: {
  options: NativeBuildOptions;
  platform: Platform;
}): Promise<NativeBuildResult> => {
  printBanner();
  const preparedConfig = await prepareNativeBuild({
    ...options,
    platform,
  });
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    process.exit(1);
  }
  const {
    buildAdapter,
    outputPath,
    scheme,
    target,
    androidSchemeConfig,
    iosSchemeConfig,
  } = preparedConfig;

  const platformName = platform === "android" ? "Android" : "iOS";

  try {
    const minBundleId = createMinBundleId(platform);

    p.log.info(
      ui.line([
        "Building",
        ui.platform(platformName),
        ui.muted(buildAdapter.name),
      ]),
    );
    // Signing credentials are resolved only by a build that signs with
    // them, and their temporary files are deleted once it finishes.
    const result = await withCredentialResolver((credentials) =>
      createNativeBuild({
        platform,
        scheme,
        minBundleId,
        target,
        readChannel: async () => (await getChannel(platform)).value,
        buildAdapter,
        outputPath,
        builder:
          platform === "android"
            ? () =>
                buildAndroid({
                  schemeConfig: androidSchemeConfig!,
                  minBundleId,
                  credentials,
                })
            : () =>
                buildIos({
                  schemeConfig: iosSchemeConfig!,
                  minBundleId,
                  credentials,
                }),
      }),
    );
    p.log.success(
      [
        ui.line([
          "Built",
          ui.platform(platformName),
          ui.muted(buildAdapter.name),
        ]),
        summarizeNativeBuild(result),
      ].join("\n"),
    );
    return result;
  } catch (e) {
    return catchError(e);
  }
};

const summarizeNativeBuild = (result: NativeBuildResult): string => {
  const rows: [label: string, value: string][] = [
    ["Artifact", ui.path(result.artifactPath)],
    ["Kind", result.artifactKind],
    ["Min bundle ID", ui.id(result.minBundleId)],
    result.fingerprintHash === null
      ? ["App version", ui.version(result.appVersion)]
      : ["Fingerprint", ui.id(result.fingerprintHash)],
    ["Channel", ui.channel(result.channel)],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length + 1));
  return rows
    .map(
      ([label, value]) =>
        `    ${ui.muted(`${label}:`.padEnd(labelWidth))} ${value}`,
    )
    .join("\n");
};

const catchError = (e: unknown): never => {
  if (e instanceof ExecaError) {
    console.error(e);
  } else if (e instanceof CredentialUnavailableError) {
    p.log.error(e.message);
  } else if (e instanceof Error) {
    p.log.error(e.stack ?? e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
};

export const buildAndroidNative = async (
  options: NativeBuildOptions,
): Promise<NativeBuildResult> => {
  return buildNativeInternal({ options, platform: "android" });
};

export const buildIosNative = async (
  options: NativeBuildOptions,
): Promise<NativeBuildResult> => {
  return buildNativeInternal({ options, platform: "ios" });
};
