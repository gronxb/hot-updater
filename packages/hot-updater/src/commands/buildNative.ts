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
  type CredentialResolver,
  type Credentials,
  getConfiguredSecrets,
  getCwd,
  BuildFailedError,
  CredentialUnavailableError,
  p,
  parseSecretReference,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type {
  NativeBuildOptions,
  Platform,
  SecretsAdapter,
} from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

import {
  createNativeBuild,
  type NativeBuildResult,
} from "@/utils/native/createNativeBuild";
import {
  type NativeBuildSchemeOptions,
  prepareNativeBuild,
} from "@/utils/native/prepareNativeBuild";
import { registerNativeBuild } from "@/utils/native/registerNativeBuild";
import { printBanner } from "@/utils/printBanner";
import { getChannel } from "@/utils/setChannel";

import { ui } from "../utils/cli-ui";
import { ensureAscApiKey } from "../utils/native/ascApiKey";
import { CredentialSetupRefusedError } from "../utils/native/issuedCredential";
import { ensurePlayServiceAccount } from "../utils/native/playServiceAccount";

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
    // The prepared config's adapter, which the credentials resolve from
    // whatever config loads after it, such as the fingerprint's.
    let secrets: SecretsAdapter | undefined;
    return await withCredentialResolver(
      async (credentials) => {
        let ascApiKey: Credentials["asc-api-key"] | undefined;
        let serviceAccount: Credentials["play-service-account"] | undefined;
        // The new service account's key: stored, or in its file.
        let serviceAccountIssued = false;
        const preparedConfig = await prepareNativeBuild({
          ...options,
          platform,
          operation: "build",
          // A scheme the store would refuse, or a missing signing or upload
          // credential, fails before the prebuild and the build, so a CI run
          // without one stops at once. The resolver keeps each credential for
          // the build, which resolves the signing ones again, an upload key
          // that signs too is one item, and a service account stays in
          // memory. Credentials asked for together share one secrets read.
          beforePrebuild: async ({
            scheme,
            secrets: configured,
            iosScheme,
            androidScheme,
          }) => {
            secrets = configured;
            const uploadKey =
              upload === "testflight"
                ? await reportUploadFailure(async () =>
                    resolveTestFlightUploadKey({
                      scheme,
                      iosScheme: iosScheme!,
                    }),
                  )
                : undefined;
            const uploadServiceAccount =
              upload === "play-internal"
                ? await reportUploadFailure(async () =>
                    resolvePlayUploadServiceAccount({
                      scheme,
                      androidScheme: androidScheme!,
                    }),
                  )
                : undefined;
            // The key the upload or the device build's signing resolves: a
            // developer without one signs in with their Apple Account here,
            // before anything is built, and Hot Updater issues it.
            const ascApiKeyName =
              uploadKey?.name ??
              (iosScheme && !iosScheme.simulator && iosScheme.signing?.ascApiKey
                ? parseSecretReference(
                    iosScheme.signing.ascApiKey,
                    "signing.ascApiKey",
                  )
                : undefined);
            if (ascApiKeyName) {
              try {
                const ensured = await ensureAscApiKey({
                  name: ascApiKeyName,
                  secrets,
                });
                // A key the adapter does not read back here is in its copy:
                // this build signs and uploads with it from there.
                if (ensured.status === "issued" && ensured.secrets) {
                  secrets = ensured.secrets;
                }
              } catch (e) {
                if (e instanceof CredentialSetupRefusedError) throw e;
                throw new NativeBuildFailure(
                  e instanceof Error ? e.message : String(e),
                  { cause: e },
                );
              }
            }
            if (uploadServiceAccount) {
              // A developer without one signs in with Google here, before
              // anything is built, and Hot Updater issues it.
              try {
                const packageName =
                  androidScheme!.applicationId ?? androidScheme!.packageName;
                const name =
                  uploadServiceAccount.name ?? uploadServiceAccount.kind;
                const ensured = await ensurePlayServiceAccount({
                  name,
                  secrets,
                  ...(packageName ? { packageName } : {}),
                });
                if (ensured.status === "issued") {
                  serviceAccountIssued = true;
                  // A key the adapter does not read back here is in its
                  // copy: this build uploads with it from there.
                  if (ensured.secrets) secrets = ensured.secrets;
                }
              } catch (e) {
                if (e instanceof CredentialSetupRefusedError) throw e;
                throw new NativeBuildFailure(
                  e instanceof Error ? e.message : String(e),
                  { cause: e },
                );
              }
            }
            [, ascApiKey, serviceAccount] = await Promise.all([
              resolveSigningCredentials(credentials, {
                iosScheme,
                androidScheme,
              }),
              uploadKey && credentials.resolve(uploadKey),
              uploadServiceAccount && credentials.resolve(uploadServiceAccount),
            ]);
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
            [
              serviceAccountIssued
                ? "If Google Play refused the new service account, it may not have its access yet: the key is stored, so run the build again in a few minutes without signing in."
                : undefined,
              `The build stays at ${result.artifactPath}.`,
            ]
              .filter(Boolean)
              .join("\n"),
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
          console.log(
            JSON.stringify({ build: result, nativeBuild: registered }),
          );
        }
        return result;
      },
      { secrets: () => secrets ?? getConfiguredSecrets() },
    );
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
 * Resolves the credentials the build signs with: an iOS device build's
 * `signing.ascApiKey`, and a release variant's `signing.keystore`, as
 * `buildIos` and `buildAndroid` resolve them.
 */
const resolveSigningCredentials = async (
  credentials: CredentialResolver,
  {
    iosScheme,
    androidScheme,
  }: Pick<NativeBuildSchemeOptions, "iosScheme" | "androidScheme">,
): Promise<void> => {
  const ascApiKey = iosScheme?.simulator
    ? undefined
    : iosScheme?.signing?.ascApiKey;
  const keystore = /debug$/i.test(androidScheme?.variant ?? "Release")
    ? undefined
    : androidScheme?.signing?.keystore;
  await Promise.all([
    ascApiKey &&
      credentials.resolve({
        kind: "asc-api-key",
        name: parseSecretReference(ascApiKey, "signing.ascApiKey"),
      }),
    keystore &&
      credentials.resolve({
        kind: "android-keystore",
        name: parseSecretReference(keystore, "signing.keystore"),
      }),
  ]);
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
  if (e instanceof CredentialSetupRefusedError) {
    // canSignIn or canPrompt reported why, with the command to run.
  } else if (e instanceof ExecaError) {
    console.error(e);
  } else if (
    e instanceof CredentialUnavailableError ||
    e instanceof NativeBuildFailure ||
    // Its logger printed the tool's errors and the log's path.
    e instanceof BuildFailedError
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
