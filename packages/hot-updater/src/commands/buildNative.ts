import { buildAndroid } from "@hot-updater/android-helper";
import {
  buildIos,
  resolveTestFlightUploadKey,
  uploadToTestFlight,
} from "@hot-updater/apple-helper";
import {
  type CredentialRequest,
  createMinBundleId,
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
  upload?: "testflight";
};

const buildNativeInternal = async ({
  options: { register = false, upload, ...options },
  platform,
}: {
  options: BuildNativeOptions;
  platform: Platform;
}): Promise<NativeBuildResult> => {
  printBanner();
  const preparedConfig = await prepareNativeBuild({
    ...options,
    platform,
    operation: "build",
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
    // A scheme the store would refuse fails before it builds.
    let testFlightKey: CredentialRequest<"asc-api-key"> | undefined;
    if (upload === "testflight") {
      testFlightKey = await reportUploadFailure(() =>
        resolveTestFlightUploadKey(iosSchemeConfig!),
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
    // Signing credentials are resolved only by a build that signs with
    // them, and their temporary files are deleted once it finishes.
    return await withCredentialResolver(async (credentials) => {
      // The upload key is resolved before the build, so a missing one fails
      // before the build starts. The scheme's signing key is the same item.
      const ascApiKey =
        testFlightKey && (await credentials.resolve(testFlightKey));
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
      if (ascApiKey) {
        const { state, testFlightUrl } = await reportUploadFailure(
          () =>
            uploadToTestFlight({
              ipaPath: result.artifactPath,
              apiKey: ascApiKey,
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
 * Runs a store upload step, reporting its failure by its message, which
 * names what the store refused, and exiting.
 */
const reportUploadFailure = async <T>(
  run: () => Promise<T>,
  note?: string,
): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    p.log.error(
      [e instanceof Error ? e.message : String(e), note]
        .filter(Boolean)
        .join("\n"),
    );
    process.exit(1);
  }
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
  options: BuildNativeOptions,
): Promise<NativeBuildResult> => {
  return buildNativeInternal({ options, platform: "android" });
};

export const buildIosNative = async (
  options: BuildNativeOptions,
): Promise<NativeBuildResult> => {
  return buildNativeInternal({ options, platform: "ios" });
};
