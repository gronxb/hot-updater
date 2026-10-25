import path from "path";

import {
  buildAndroid,
  readBuiltPackageName,
  resolvePlayUploadServiceAccount,
  uploadToPlay,
} from "@hot-updater/android-helper";
import {
  assertTestFlightExportOptions,
  buildIos,
  resolveTestFlightUploadKey,
  uploadToTestFlight,
} from "@hot-updater/apple-helper";
import {
  createMinBundleId,
  type Credentials,
  getCwd,
  CredentialUnavailableError,
  p,
  parseVaultReference,
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
import {
  AscApiKeyRefusedError,
  ensureAscApiKey,
} from "../utils/native/ascApiKey";

/**
 * `build:android` and `build:ios`: `register` also registers the build,
 * `upload` uploads it to a store, and `json` prints the result.
 */
export type BuildNativeOptions = NativeBuildOptions & {
  register?: boolean;
  upload?: "testflight" | "play-internal";
  /**
   * Prints `{ build, nativeBuild }` as one line of JSON, the last of the
   * output: the build, and its registration or null without `register`.
   * The registration holds what the build's artifact embeds, such as an app
   * version an xcconfig sets, which the project doesn't declare.
   */
  json?: boolean;
};

const buildNativeInternal = async ({
  options: { register = false, upload, json = false, ...options },
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
      let ascApiKey: Credentials["asc-api-key"] | undefined;
      let serviceAccount: Credentials["play-service-account"] | undefined;
      const preparedConfig = await prepareNativeBuild({
        ...options,
        platform,
        operation: "build",
        credentials: register,
        // A scheme the store would refuse, or a missing upload credential,
        // fails before the prebuild and the build. The scheme's signing key
        // is the same item, resolved once, and a service account stays in
        // memory.
        beforePrebuild: async ({ scheme, iosScheme, androidScheme }) => {
          const uploadKey =
            upload === "testflight"
              ? await reportUploadFailure(async () =>
                  resolveTestFlightUploadKey({ scheme, iosScheme: iosScheme! }),
                )
              : undefined;
          // The key the upload or the device build's signing resolves: a
          // developer without one signs in with their Apple Account here,
          // before anything is built.
          const ascApiKeyName =
            uploadKey?.name ??
            (iosScheme && !iosScheme.simulator && iosScheme.signing?.ascApiKey
              ? parseVaultReference(
                  iosScheme.signing.ascApiKey,
                  "signing.ascApiKey",
                )
              : undefined);
          if (ascApiKeyName) {
            try {
              await ensureAscApiKey({
                name: ascApiKeyName,
                bundleIdentifier: iosScheme!.bundleIdentifier,
              });
            } catch (e) {
              if (e instanceof AscApiKeyRefusedError) throw e;
              throw new NativeBuildFailure(
                e instanceof Error ? e.message : String(e),
                { cause: e },
              );
            }
          }
          if (uploadKey) {
            ascApiKey = await credentials.resolve(uploadKey);
          }
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
      if (ascApiKey) {
        // The prebuild may write the export options, which it reads.
        await reportUploadFailure(() =>
          assertTestFlightExportOptions(iosSchemeConfig!),
        );
      }

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
      const registered = register ? await registerNativeBuild(result) : null;
      const apiKey = ascApiKey;
      if (apiKey) {
        const { state, testFlightUrl } = await reportUploadFailure(
          () =>
            uploadToTestFlight({
              ipaPath: result.artifactPath,
              apiKey,
            }),
          `The build stays at ${result.artifactPath}.`,
        );
        if (state === "COMPLETE") {
          p.log.success(
            ui.line([
              "Uploaded to",
              ui.platform("TestFlight"),
              ui.path(testFlightUrl),
            ]),
          );
        }
      }
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
      if (json) {
        console.log(JSON.stringify({ build: result, nativeBuild: registered }));
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
  if (e instanceof AscApiKeyRefusedError) {
    // canPrompt reported why, with the command to run.
  } else if (e instanceof ExecaError) {
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
