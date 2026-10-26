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
  describeSecret,
  type Credentials,
  getConfiguredSecrets,
  getCwd,
  BuildFailedError,
  CredentialUnavailableError,
  loadConfig,
  p,
  parseSecretReference,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type {
  NativeBuildOptions,
  Platform,
  SecretsAdapter,
} from "@hot-updater/plugin-core";
import { NIL_UUID } from "@hot-updater/protocol";
import { ExecaError } from "execa";

import {
  createNativeBuild,
  type NativeBuildResult,
} from "@/utils/native/createNativeBuild";
import {
  type NativeBuildSchemeOptions,
  prepareNativeBuild,
} from "@/utils/native/prepareNativeBuild";
import {
  preflightNativeBuildRegistration,
  registerNativeBuild,
} from "@/utils/native/registerNativeBuild";
import { printBanner } from "@/utils/printBanner";
import { getChannel } from "@/utils/setChannel";

import { ui } from "../utils/cli-ui";
import { ensureAscApiKey } from "../utils/native/ascApiKey";
import { CredentialSetupRefusedError } from "../utils/native/issuedCredential";
import { resolveNativeBuildScope } from "../utils/native/nativeBuildScope";
import { ensurePlayServiceAccount } from "../utils/native/playServiceAccount";

/**
 * `native-build ios` and `native-build android`: every build but a Debug
 * one is tracked, recorded in Hot Updater with its artifact, as an OTA
 * patch base and preview build; `submit` submits it to a store, and `json`
 * prints the result.
 */
export interface NativeBuildCreateOptions {
  /** The `nativeBuild` scheme; without it, a prompt at a terminal. */
  readonly scheme?: string;
  readonly outputPath?: string;
  readonly submit?: "testflight" | "play-internal";
  /**
   * Builds, but records and submits nothing, as `npm publish --dry-run`
   * does: the checks run read-only, the store key is resolved but never
   * issued, and the artifact stays on this machine.
   */
  readonly dryRun?: boolean;
  /**
   * Prints `{ dryRun, build, nativeBuild, registration, submission }` as
   * one line of JSON, the last of the output: the build, its record or
   * null, why it has none (`registration.skipped`: "debug", "dry-run", or
   * null), and the store it went to (`submission.destination`, skipped on
   * a dry run). The record holds what the build's artifact embeds, such as
   * an app version an xcconfig sets, which the project doesn't declare.
   */
  readonly json?: boolean;
}

/**
 * Why a build is not tracked: a Debug build has no built-in bundle, and a
 * dry run records nothing.
 */
export type NativeBuildTrackingSkip = "debug" | "dry-run";

const buildNativeInternal = async ({
  options: { submit: upload, dryRun = false, json = false, ...schemeOptions },
  platform,
}: {
  options: NativeBuildCreateOptions;
  platform: Platform;
}): Promise<NativeBuildResult> => {
  // Without a scheme, prepareNativeBuild asks for one at a terminal and
  // refuses elsewhere with the --scheme form.
  const options: NativeBuildOptions = {
    ...schemeOptions,
    interactive: schemeOptions.scheme === undefined,
  };
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
        let serviceAccountIssued: "stored" | { file: string } | undefined;
        // Why the build is not tracked, decided before it is built.
        let trackingSkipped: NativeBuildTrackingSkip | null = null;
        // A dry run's missing store key: reported, and the run fails at the end.
        let missingSubmitKey: string | undefined;
        const preparedConfig = await prepareNativeBuild({
          ...options,
          platform,
          // A scheme the store would refuse, or a missing signing or upload
          // credential, fails before the prebuild and the build, so a CI run
          // without one stops at once. The resolver keeps each credential for
          // the build, which resolves the signing ones again, an upload key
          // that signs too is one item, and a service account stays in
          // memory. Credentials asked for together share one secrets read.
          beforePrebuild: async ({
            scheme,
            secrets: configured,
            cacheDir,
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
            trackingSkipped = await prepareTracking({
              platform,
              scheme,
              json,
              debug: /debug$/i.test(
                (platform === "android"
                  ? androidScheme?.variant
                  : iosScheme?.configuration) ?? "Release",
              ),
            });
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
            // A dry run never signs in: it only reads the keys it would use.
            if (ascApiKeyName && !dryRun) {
              try {
                const ensured = await ensureAscApiKey({
                  name: ascApiKeyName,
                  secrets,
                  cacheDir,
                });
                // A key builds here can't read from the adapter is in its
                // file: this build signs and uploads with it from there.
                if (
                  (ensured.status === "saved" || ensured.status === "issued") &&
                  ensured.secrets
                ) {
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
            if (uploadServiceAccount && !dryRun) {
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
                  cacheDir,
                  ...(packageName ? { packageName } : {}),
                });
                if (ensured.status === "issued") {
                  serviceAccountIssued = "stored";
                  // A key the adapter does not read back here is in its
                  // copy: this build uploads with it from there.
                  if (ensured.secrets) {
                    secrets = ensured.secrets;
                    serviceAccountIssued = {
                      file: describeSecret(ensured.secrets, name),
                    };
                  }
                }
                if (ensured.status === "saved") {
                  serviceAccountIssued = { file: ensured.file };
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
            /** A dry run's store key: one it lacks is reported, not fatal. */
            const submitKey = async <T>(resolve: () => Promise<T>) => {
              if (!dryRun) return resolve();
              try {
                return await resolve();
              } catch (error) {
                if (!(error instanceof CredentialUnavailableError)) throw error;
                missingSubmitKey = error.message;
                return undefined;
              }
            };
            [, ascApiKey, serviceAccount] = await Promise.all([
              resolveSigningCredentials(credentials, {
                iosScheme,
                androidScheme,
              }),
              uploadKey && submitKey(() => credentials.resolve(uploadKey)),
              uploadServiceAccount &&
                submitKey(() => credentials.resolve(uploadServiceAccount)),
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
        if (dryRun) trackingSkipped = "dry-run";
        const registered =
          trackingSkipped === null ? await trackBuild(result, upload) : null;
        const apiKey = dryRun ? undefined : ascApiKey;
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
        const playServiceAccount = dryRun ? undefined : serviceAccount;
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
              serviceAccountIssued === "stored"
                ? "If Google Play refused the new service account, it may not have its access yet: the key is stored, so run the build again in a few minutes without signing in."
                : serviceAccountIssued
                  ? `If Google Play refused the new service account, it may not have its access yet: the key is in ${serviceAccountIssued.file}, so store it as shown above, then run the build again in a few minutes without signing in.`
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
        if (dryRun) {
          p.log.message(summarizeDryRun(result, upload));
        }
        if (json) {
          console.log(
            JSON.stringify({
              dryRun,
              build: result,
              nativeBuild: registered,
              registration: { skipped: trackingSkipped },
              submission: {
                destination: upload ?? null,
                skipped: dryRun && upload ? "dry-run" : null,
              },
            }),
          );
        }
        if (missingSubmitKey !== undefined) {
          throw new NativeBuildFailure(
            `The dry run built, and a real run could not submit to ${upload === "testflight" ? "TestFlight" : "Google Play"}: ${missingSubmitKey}`,
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

/**
 * Decides, before anything is built or any sign-in, whether the build is
 * tracked, and checks that it can be: a Debug build is not, which a line
 * says; any other build's server must answer the registry and its storage,
 * or the command stops here, in seconds, naming which it can't reach.
 */
const prepareTracking = async ({
  platform,
  scheme,
  json,
  debug,
}: {
  platform: Platform;
  scheme: string;
  json: boolean;
  debug: boolean;
}): Promise<NativeBuildTrackingSkip | null> => {
  if (debug) {
    p.log.info(
      `Not tracking this build: the scheme ${scheme} builds Debug, which loads its JavaScript from Metro and has no built-in bundle to track.`,
    );
    return "debug";
  }
  try {
    await preflightNativeBuildRegistration(
      await resolveNativeBuildScope(
        await loadConfig({ platform, channel: "" }),
        { platform, scheme, json },
      ),
    );
  } catch (error) {
    throw new NativeBuildFailure(
      `Hot Updater tracks every native build, and can't reach ${error instanceof Error ? error.message : String(error)}\nNothing was built. Check the database and storage in hot-updater.config.ts, and their credentials.`,
      { cause: error },
    );
  }
  return null;
};

/**
 * Tracks the build, before any store submission: a build Hot Updater could
 * not track is submitted nowhere, and stays at its path.
 */
const trackBuild = async (
  result: NativeBuildResult,
  upload: NativeBuildCreateOptions["submit"],
) => {
  try {
    return await registerNativeBuild(result);
  } catch (error) {
    throw new NativeBuildFailure(
      [
        `Tracking the native build failed: ${error instanceof Error ? error.message : String(error)}`,
        `The build stays at ${result.artifactPath}${upload ? `, and was not submitted to ${upload === "testflight" ? "TestFlight" : "Google Play"}` : ""}.`,
      ].join("\n"),
      { cause: error },
    );
  }
};

/** What a dry run would have recorded and where it would have submitted. */
const summarizeDryRun = (
  result: NativeBuildResult,
  upload: NativeBuildCreateOptions["submit"],
): string =>
  ui.block("Dry run: nothing was recorded or submitted", [
    ui.kv("Platform", ui.platform(result.platform)),
    ui.kv("Channel", ui.channel(result.channel)),
    result.fingerprintHash === null
      ? ui.kv("App version", ui.version(result.appVersion))
      : ui.kv("Fingerprint", ui.id(result.fingerprintHash)),
    ui.kv("Min bundle ID", ui.id(result.minBundleId)),
    ui.kv("Artifact", ui.path(result.artifactPath)),
    ui.kv(
      "Would record",
      result.minBundleId === NIL_UUID
        ? "nothing: a Debug build has no built-in bundle"
        : "this native build, its artifact, and its built-in bundle, in Hot Updater",
    ),
    ui.kv(
      "Would submit",
      upload === "testflight"
        ? "to TestFlight"
        : upload === "play-internal"
          ? "to Google Play's internal testing track"
          : "nothing (no --submit)",
    ),
  ]);

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

/** `native-build ios` and `native-build android`. */
export const handleNativeBuildCreate = async (
  platform: Platform,
  options: NativeBuildCreateOptions,
): Promise<NativeBuildResult> => buildNativeInternal({ options, platform });
