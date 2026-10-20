import path from "path";

import {
  buildAndroid,
  readBuiltPackageName,
  resolvePlayUploadServiceAccount,
  uploadToPlay,
} from "@hot-updater/android-helper";
import { buildIos } from "@hot-updater/apple-helper";
import {
  createMinBundleId,
  type Credentials,
  getCwd,
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
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { registerNativeBuild } from "@/utils/native/registerNativeBuild";
import { printBanner } from "@/utils/printBanner";
import { getChannel } from "@/utils/setChannel";

import { ui } from "../utils/cli-ui";

/**
 * `build:android` and `build:ios`: `register` also registers the build, and
 * `upload` uploads it to a store.
 */
export type BuildNativeOptions = NativeBuildOptions & {
  register?: boolean;
  upload?: "play-internal";
};

const buildNativeInternal = async ({
  options: { register = false, upload, ...options },
  platform,
}: {
  options: BuildNativeOptions;
  platform: Platform;
}): Promise<NativeBuildResult> => {
  printBanner();
  const platformName = platform === "android" ? "Android" : "iOS";

  try {
    // Signing and upload credentials are resolved only by a build that uses
    // them, and their temporary files are deleted once it finishes.
    return await withCredentialResolver(async (credentials) => {
      let serviceAccount: Credentials["play-service-account"] | undefined;
      const preparedConfig = await prepareNativeBuild({
        ...options,
        platform,
        operation: "build",
        // A scheme the store would refuse, or a missing upload credential,
        // fails before the prebuild and the build. The service account
        // stays in memory.
        beforePrebuild: async ({ scheme, androidScheme }) => {
          if (upload === "play-internal") {
            const request = await reportUploadFailure(async () =>
              resolvePlayUploadServiceAccount({
                scheme,
                androidScheme: androidScheme!,
              }),
            );
            serviceAccount = await credentials.resolve(request);
          }
        },
      });
      if (!preparedConfig) {
        throw new NativeBuildFailure("preparing native build failed");
      }
      const {
        buildAdapter,
        outputPath,
        scheme,
        target,
        androidSchemeConfig,
        iosSchemeConfig,
      } = preparedConfig;

      const minBundleId = createMinBundleId(platform);

      p.log.info(
        ui.line([
          "Building",
          ui.platform(platformName),
          ui.muted(buildAdapter.name),
        ]),
      );
      const result = await createNativeBuild({
        platform,
        scheme,
        minBundleId,
        target,
        // The native SDK of a Debug build reports the nil UUID as its
        // MIN_BUNDLE_ID. Its debug flag follows the variant or configuration
        // the app builds, which neither the artifact nor the app target's
        // build settings expose, so the name decides, as for signing.
        debug: /debug$/i.test(
          platform === "android"
            ? androidSchemeConfig!.variant
            : iosSchemeConfig!.configuration,
        ),
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
      });
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
      if (register) await registerNativeBuild(result);
      const playServiceAccount = serviceAccount;
      if (playServiceAccount) {
        const { versionCode, status } = await reportUploadFailure(
          async () =>
            uploadToPlay({
              aabPath: result.artifactPath,
              // The artifact's, with the suffixes flavors and build types add.
              packageName:
                (await readBuiltPackageName({
                  artifactPath: result.artifactPath,
                  androidProjectPath: path.join(getCwd(), "android"),
                })) ?? androidSchemeConfig!.applicationId,
              serviceAccount: playServiceAccount,
            }),
          `The build stays at ${result.artifactPath}.`,
        );
        p.log.success(
          ui.line([
            status === "draft" ? "Uploaded as a draft to" : "Uploaded to",
            ui.platform("Google Play internal testing"),
            ui.muted(`version code ${versionCode}`),
          ]),
        );
      }
      return result;
    });
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

/**
 * A failure reported by its message alone, thrown so the credential
 * resolver deletes its temporary files before the process exits.
 */
class NativeBuildFailure extends Error {}

/**
 * Runs a store upload step, whose failure names what the store refused,
 * with `note` after it.
 */
const reportUploadFailure = async <T>(
  run: () => Promise<T>,
  note?: string,
): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    throw new NativeBuildFailure(
      [e instanceof Error ? e.message : String(e), note]
        .filter(Boolean)
        .join("\n"),
      { cause: e },
    );
  }
};

const catchError = (e: unknown): never => {
  if (e instanceof ExecaError) {
    console.error(e);
  } else if (
    e instanceof CredentialUnavailableError ||
    e instanceof NativeBuildFailure
  ) {
    p.log.error(e.message);
  } else if (e instanceof Error) {
    p.log.error(e.stack ?? e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
};

export const buildAndroidNative = async (
  options: BuildNativeOptions,
): Promise<NativeBuildResult> => {
  return buildNativeInternal({ options, platform: "android" });
};

export const buildIosNative = async (
  options: BuildNativeOptions,
): Promise<NativeBuildResult> => {
  return buildNativeInternal({ options, platform: "ios" });
};
