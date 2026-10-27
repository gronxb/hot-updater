import path from "path";

import {
  buildAndroid,
  type EnrichedNativeBuildAndroidScheme,
  findPlayInternalRelease,
  assertPlaySigned,
  PlayVersionCodeUsedError,
  readBuiltApp,
  readBuiltPackageName,
  readBuiltVersionCode,
  resolvePlayUploadServiceAccount,
  uploadToPlay,
} from "@hot-updater/android-helper";
import {
  assertTestFlightExportOptions,
  buildIos,
  type EnrichedNativeBuildIosScheme,
  findTestFlightBuild,
  installPodsIfNeeded,
  TestFlightBuildExistsError,
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
  loadConfig,
  p,
  parseSecretReference,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type {
  BuildAdapter,
  NativeBuildOptions,
  NativeBuildRow,
  NativeBuildSubmissionDestination,
  Platform,
  SecretsAdapter,
} from "@hot-updater/plugin-core";
import { NIL_UUID } from "@hot-updater/protocol";
import { ExecaError } from "execa";

import {
  createNativeBuild,
  type NativeBuildResult,
  type NativeBuildTarget,
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
import type { NativeBuildCacheHit } from "../utils/native/nativeBuildCache";
import { resolveNativeBuildScope } from "../utils/native/nativeBuildScope";
import {
  recordNativeBuildSubmission,
  storeVersionLabel,
} from "../utils/native/nativeBuildSubmission";
import { ensurePlayServiceAccount } from "../utils/native/playServiceAccount";
import {
  type NativeBuildCache,
  rememberTrackedBuild,
  reuseNativeBuild,
} from "../utils/native/reuseNativeBuild";

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
   * `false` (`--no-cache`) builds even when a build with the same native
   * build key can be reused, such as after a change outside the project
   * that no key covers, like a provisioning profile; the new build is still
   * recorded with its key.
   */
  readonly cache?: boolean;
  /**
   * Prints `{ dryRun, build, nativeBuild, registration, submission, cache }`
   * as one line of JSON, the last of the output: the build, its record or
   * null, why it has none (`registration.skipped`: "debug", "dry-run", or
   * null), the store it went to (`submission.destination`, skipped on a
   * dry run, or when the store already has a reused build), and the build
   * it reused (`cache.hit`: "storage", "local", or null, with the key, why
   * none could be, and what changed). The record holds what the build's
   * artifact embeds, such as an app version an xcconfig sets, which the
   * project doesn't declare.
   */
  readonly json?: boolean;
}

/**
 * Why a build is not tracked: a Debug build has no built-in bundle, and a
 * dry run records nothing.
 */
export type NativeBuildTrackingSkip = "debug" | "dry-run";

const buildNativeInternal = async ({
  options: {
    submit: upload,
    dryRun = false,
    json = false,
    cache: useCache = true,
    ...schemeOptions
  },
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
        // Whether a sign-in issued the service account's key.
        let serviceAccountIssued = false;
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
          config,
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

        // The pods a scheme installs resolve before the key is computed, so
        // the key holds the Podfile.lock they resolved to, which a project
        // whose ios/ the prebuild generates has no other way to have. The
        // build then uses them as installed.
        const installsPods = platform === "ios" && iosSchemeConfig!.installPods;
        if (installsPods) {
          await installPodsIfNeeded(path.join(getCwd(), "ios"));
        }
        // Debug builds are neither tracked nor cached.
        const cache: NativeBuildCache | null =
          trackingSkipped === "debug"
            ? null
            : await reuseNativeBuild({
                platform,
                scheme,
                cacheDir: config.cacheDir,
                outputPath,
                target,
                iosScheme: iosSchemeConfig,
                androidScheme: androidSchemeConfig,
                credentials,
                noCache: !useCache,
                buildAdapter: buildAdapter.name,
              });
        const reused = cache?.hit ?? null;
        const result = reused
          ? reused.result
          : await buildNow({
              platform,
              platformName,
              scheme,
              target,
              buildAdapter,
              outputPath,
              androidSchemeConfig,
              iosSchemeConfig: installsPods
                ? { ...iosSchemeConfig!, installPods: false }
                : iosSchemeConfig,
              credentials,
            });
        if (!reused) await cache?.remember(result, null);
        if (dryRun) trackingSkipped = "dry-run";
        // A build reused from storage is tracked already; one reused from
        // this machine is tracked with the key it was cached under.
        let registered =
          trackingSkipped !== null
            ? null
            : reused?.source === "storage"
              ? reused.nativeBuild
              : await trackBuild(result, upload, cache?.key.key ?? null);
        if (registered && reused?.source !== "storage" && cache) {
          await rememberTrackedBuild(cache, registered.id);
        }
        // A reused build may be in the store already, which takes a build
        // number once: it is not submitted again.
        // A store takes a build number once: a build it already has is not
        // uploaded again. The tracked build's record says so first; a
        // reused build without one is looked up in the store; and the
        // store's own refusal of the build number says so last.
        let existingSubmission: ExistingSubmission | null =
          upload && !dryRun && registered?.submitted_to === upload
            ? {
                destination: upload,
                version: registered.submitted_version,
                submittedAtMs: registered.submitted_at_ms,
                source: "recorded",
              }
            : null;
        if (existingSubmission) logAlreadySubmitted(existingSubmission);
        const apiKey = dryRun ? undefined : ascApiKey;
        if (apiKey && reused && !existingSubmission) {
          const existing = await reportUploadFailure(() =>
            findTestFlightBuild({ ipaPath: result.artifactPath, apiKey }),
          );
          if (existing.found) {
            existingSubmission = {
              destination: "testflight",
              version: storeVersionLabel(
                existing.shortVersion,
                existing.bundleVersion,
              ),
              submittedAtMs: null,
              source: "store",
            };
            logAlreadySubmitted(existingSubmission, existing.testFlightUrl);
            registered = await recordSubmission(
              registered,
              "testflight",
              () =>
                storeVersionLabel(
                  existing.shortVersion,
                  existing.bundleVersion,
                ),
              { onlyUnrecorded: true },
            );
          }
        }
        if (apiKey && !existingSubmission) {
          const uploaded = await storeRefusal(
            reportUploadFailure(
              () =>
                uploadToTestFlight({
                  ipaPath: result.artifactPath,
                  apiKey,
                }),
              `The build stays at ${result.artifactPath}.`,
            ),
            (cause) =>
              cause instanceof TestFlightBuildExistsError
                ? storeVersionLabel(cause.shortVersion, cause.bundleVersion)
                : undefined,
            "testflight",
          );
          if ("refused" in uploaded) {
            existingSubmission = uploaded.refused;
          } else if (uploaded.state === "COMPLETE") {
            p.log.success(
              ui.line([
                "Uploaded to",
                ui.platform("TestFlight"),
                ui.path(uploaded.testFlightUrl),
              ]),
            );
            // Recorded once App Store Connect accepted the build; a build
            // still processing is recorded by the next run, which finds it.
            registered = await recordSubmission(registered, "testflight", () =>
              storeVersionLabel(uploaded.shortVersion, uploaded.bundleVersion),
            );
          }
        }
        const playServiceAccount =
          dryRun || existingSubmission ? undefined : serviceAccount;
        if (playServiceAccount) {
          // The artifact's, with the suffixes flavors and build types add.
          const androidProjectPath = path.join(getCwd(), "android");
          const packageName =
            (await readBuiltPackageName({
              artifactPath: result.artifactPath,
              androidProjectPath,
            })) ?? androidSchemeConfig!.applicationId;
          const playVersionLabel = async (versionCode: string | number) =>
            storeVersionLabel(
              await readVersionName(result, androidProjectPath),
              versionCode,
            );
          if (reused) {
            const versionCode = await readBuiltVersionCode({
              artifactPath: result.artifactPath,
              androidProjectPath,
            });
            if (
              versionCode !== undefined &&
              (await reportUploadFailure(() =>
                findPlayInternalRelease({
                  versionCode,
                  packageName,
                  serviceAccount: playServiceAccount,
                }),
              ))
            ) {
              existingSubmission = {
                destination: "play-internal",
                version: await playVersionLabel(versionCode),
                submittedAtMs: null,
                source: "store",
              };
              logAlreadySubmitted(existingSubmission);
              registered = await recordSubmission(
                registered,
                "play-internal",
                () => playVersionLabel(versionCode),
                { onlyUnrecorded: true },
              );
            }
          }
          if (!existingSubmission) {
            // Google Play refuses a debug-signed .aab after the upload.
            await reportUploadFailure(
              () => assertPlaySigned(result.artifactPath),
              `The build stays at ${result.artifactPath}.`,
            );
            const versionCodeOfArtifact = async () =>
              result.buildNumber ??
              (await readBuiltVersionCode({
                artifactPath: result.artifactPath,
                androidProjectPath,
              })) ??
              null;
            const uploaded = await storeRefusal(
              reportUploadFailure(
                async () =>
                  uploadToPlay({
                    aabPath: result.artifactPath,
                    packageName,
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
              ),
              // The version code is read only once Google Play refused it.
              (cause) =>
                cause instanceof PlayVersionCodeUsedError
                  ? versionCodeOfArtifact().then((code) =>
                      code === null ? null : playVersionLabel(code),
                    )
                  : undefined,
              "play-internal",
            );
            if ("refused" in uploaded) {
              existingSubmission = uploaded.refused;
            } else {
              const { versionCode, status } = uploaded;
              p.log.success(
                ui.line([
                  status === "draft" ? "Uploaded as a draft to" : "Uploaded to",
                  ui.platform("Google Play internal testing"),
                  ui.muted(`version code ${versionCode}`),
                ]),
              );
              // Google Play took the bundle on the internal track, as a draft
              // release when the app is not published yet.
              registered = await recordSubmission(
                registered,
                "play-internal",
                () => playVersionLabel(versionCode),
              );
            }
          }
        }
        const alreadySubmitted = existingSubmission !== null;
        if (dryRun) {
          p.log.message(summarizeDryRun(result, upload, reused));
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
                skipped:
                  dryRun && upload
                    ? "dry-run"
                    : alreadySubmitted
                      ? "already-submitted"
                      : null,
                // The store's build that kept this one from uploading.
                existing: existingSubmission,
              },
              cache: cache?.report ?? {
                hit: null,
                key: null,
                uncacheable: "a Debug build loads its JavaScript from Metro",
                changed: [],
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
 * Builds the app: issues the build's MIN_BUNDLE_ID, runs the platform's
 * build and the adapter's postbuild, and copies the output to `outputPath`.
 */
const buildNow = async ({
  platform,
  platformName,
  scheme,
  target,
  buildAdapter,
  outputPath,
  androidSchemeConfig,
  iosSchemeConfig,
  credentials,
}: {
  platform: Platform;
  platformName: string;
  scheme: string;
  target: NativeBuildTarget;
  buildAdapter: BuildAdapter;
  outputPath: string;
  androidSchemeConfig?: EnrichedNativeBuildAndroidScheme;
  iosSchemeConfig?: EnrichedNativeBuildIosScheme;
  credentials: CredentialResolver;
}): Promise<NativeBuildResult> => {
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
  return result;
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
  // The scope the build would have, read without writing the native
  // projects. An adapter whose prebuild generates them may leave nothing to
  // read yet: the registry is then checked without a scope.
  const scope = await resolveNativeBuildScope(
    await loadConfig({ platform, channel: "" }),
    { platform, scheme, json },
  ).catch(() => null);
  try {
    await preflightNativeBuildRegistration(scope);
  } catch (error) {
    throw new NativeBuildFailure(
      `Hot Updater tracks every native build, and can't reach ${error instanceof Error ? error.message : String(error)}\nNothing was built. Check the database and storage in hot-updater.config.ts, and their credentials.`,
      { cause: error },
    );
  }
  return null;
};

/**
 * A build the store already has, which kept this run from uploading: from
 * the tracked build's record (with its time), the store's lookup of a
 * reused build, or the store's refusal of the build number.
 */
interface ExistingSubmission {
  readonly destination: NativeBuildSubmissionDestination;
  /** The store's label of the build, such as `1.7.0 (66)`. */
  readonly version: string | null;
  /** When Hot Updater recorded it, or null when the store said so. */
  readonly submittedAtMs: number | null;
  readonly source: "recorded" | "store";
}

const STORE_NAMES = {
  testflight: "TestFlight",
  "play-internal": "Google Play internal testing",
} as const;

/** `2026-10-27 04:02 UTC`. */
const formatUtc = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Says the store already has the build, which this run doesn't upload
 * again: a store takes each build number once.
 */
const logAlreadySubmitted = (existing: ExistingSubmission, url?: string) =>
  p.log.info(
    [
      `Already on ${STORE_NAMES[existing.destination]}`,
      existing.submittedAtMs === null
        ? ""
        : ` since ${formatUtc(existing.submittedAtMs)}`,
      existing.version === null ? "" : ` as ${existing.version}`,
      `. Bump the build number to upload a new build.`,
      url ? ` ${url}` : "",
    ].join(""),
  );

/**
 * The upload's result, or the build the store already has when it refused
 * the build number, from this or another upload: the run then skips the
 * upload as for a build it already submitted, and records nothing, since
 * the store's build may not be this artifact.
 */
const storeRefusal = async <T>(
  upload: Promise<T>,
  labelOf: (cause: unknown) => Promise<string | null> | string | undefined,
  destination: NativeBuildSubmissionDestination,
): Promise<T | { readonly refused: ExistingSubmission }> => {
  try {
    return await upload;
  } catch (error) {
    const cause = error instanceof NativeBuildFailure ? error.cause : error;
    const label = labelOf(cause);
    if (label === undefined) throw error;
    const refused: ExistingSubmission = {
      destination,
      version: await label,
      submittedAtMs: null,
      source: "store",
    };
    logAlreadySubmitted(refused);
    return { refused };
  }
};

/**
 * The version name the built `.apk` or `.aab` reports, or its scheme's app
 * version, or null when neither can be read: aapt2 reads the artifact.
 */
const readVersionName = async (
  result: NativeBuildResult,
  androidProjectPath: string,
): Promise<string | null> =>
  (
    await readBuiltApp({
      artifactPath: result.artifactPath,
      androidProjectPath,
    })
  )?.appVersion ?? result.appVersion;

/**
 * Records on the tracked build that the store took it. An untracked build,
 * such as a Debug one, records nothing; `onlyUnrecorded` keeps a record a
 * run that uploaded the build made. A failed record fails the command,
 * since the Console would not show the submission: the store keeps the
 * build, and a run with the same inputs finds it there and records it.
 */
const recordSubmission = async (
  build: NativeBuildRow | null,
  destination: NativeBuildSubmissionDestination,
  /** The store's label of the build, read only for a tracked build. */
  readVersion: () => string | Promise<string>,
  { onlyUnrecorded = false }: { readonly onlyUnrecorded?: boolean } = {},
): Promise<NativeBuildRow | null> => {
  if (!build || (onlyUnrecorded && build.submitted_to !== null)) {
    return build;
  }
  const version = await readVersion();
  try {
    return await recordNativeBuildSubmission(build, destination, version);
  } catch (error) {
    throw new NativeBuildFailure(
      [
        `${destination === "testflight" ? "TestFlight" : "Google Play"} has build ${version}, but recording it on native build ${build.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        "Run the same command again: it reuses the build, finds it in the store, and records it.",
      ].join("\n"),
      { cause: error },
    );
  }
};

/**
 * Tracks the build, before any store submission: a build Hot Updater could
 * not track is submitted nowhere, and stays at its path.
 */
const trackBuild = async (
  result: NativeBuildResult,
  upload: NativeBuildCreateOptions["submit"],
  buildKey: string | null,
) => {
  try {
    return await registerNativeBuild(result, { buildKey });
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
  reused: NativeBuildCacheHit | null,
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
        : reused?.source === "storage"
          ? `nothing: Hot Updater tracks this build as ${reused.nativeBuild.id}`
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
