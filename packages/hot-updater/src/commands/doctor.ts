import fs from "fs";
import path from "path";

import {
  type ConfigResponse,
  getBundleSigningPublicKey,
  getCwd,
  loadConfig,
  LOCAL_SECRETS_NAME,
  p,
  readPackageUp,
  nonInteractiveReason,
} from "@hot-updater/cli-tools";
import type { PluginClientPlugin } from "@hot-updater/plugin-core";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import {
  findMinimumForRange,
  normalize,
  normalizeRange,
  satisfies,
} from "verkit";

import { packageJsonData } from "../packageJson";
import { type MaybeRow, ui } from "../utils/cli-ui";
import { AndroidConfigParser } from "../utils/configParser/androidParser";
import { IosConfigParser } from "../utils/configParser/iosParser";
import type { FingerprintResult } from "../utils/fingerprint/common";
import { showFingerprintChanges } from "../utils/fingerprint/diff";
import {
  type SigningConfigIssue,
  validateSigningConfig,
} from "../utils/signing/validateSigningConfig";
import { getNativeAppVersion } from "../utils/version/getNativeAppVersion";
import { findMissingClientPlugins } from "./doctor/clientPlugins";
import { createDoctorContext, type DoctorContext } from "./doctor/context";
import {
  checkFingerprintJson,
  checkUnusedFingerprintJson,
} from "./doctor/fingerprint";
import {
  checkGooglePlay,
  formatGooglePlayStatus,
  type GooglePlayStatus,
} from "./doctor/googlePlay";
import {
  type NativeCheckIssue,
  type NativePlatform,
  type ReleaseCatalogStatus,
  type SchemaStatus,
} from "./doctor/issues";
import {
  findScaffoldDeployments,
  recordedBaseUrls,
} from "./doctor/scaffoldRecords";
import { checkSchema } from "./doctor/schema";
import {
  checkSecretEnv,
  secretEnvAdvice,
  type SecretEnvStatus,
  secretEnvInitCommand,
} from "./doctor/secretEnv";
import { checkSecrets, type SecretsStatus } from "./doctor/secrets";
import { checkServerData, releaseCatalogsUnchecked } from "./doctor/serverData";
import {
  hasVerificationOptions,
  verifyInfrastructure,
  type DoctorVerification,
  type VerificationOptions,
} from "./doctor/verification";
import {
  checkInfrastructureStatus,
  createInfrastructureRemediation,
  getRequiredUpdateTarget,
  type InfrastructureStatus,
} from "./doctorInfrastructure";
import { INIT_PROVIDER_PACKAGES } from "./initProviders";

export {
  checkInfrastructureStatus,
  createInfrastructureRemediation,
  getRequiredInfrastructureVersion,
  getRequiredServerVersion,
  isInfrastructureUpdateRequired,
  resolveVersionEndpoint,
} from "./doctorInfrastructure";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface VersionMismatch {
  packageName: string;
  currentVersion: string;
  expectedVersion: string;
}

interface NativePlatformStatus {
  detected: boolean;
  files: string[];
  /** The version the native project builds: what the app reports. */
  appVersion?: string;
  channel?: string;
  bundleProviderConfigured?: boolean;
}

interface NativeStatus {
  updateStrategy: ConfigResponse["updateStrategy"];
  fingerprintJsonPath?: string;
  ios?: NativePlatformStatus;
  android?: NativePlatformStatus;
  issues: NativeCheckIssue[];
}

interface LocalFingerprint {
  ios?: FingerprintResult | null;
  android?: FingerprintResult | null;
}

interface DoctorDetails {
  verification?: DoctorVerification;
  // Version related
  hotUpdaterVersion?: string;
  versionMismatches?: VersionMismatch[];
  infrastructure?: InfrastructureStatus & {
    /** The scaffold deployment record the server's URL came from, without --server-base-url. */
    recordedIn?: string;
  };
  /** The server's version was not checked: no URL was given or recorded. */
  infrastructureUnchecked?: {
    message: string;
    resolution: string;
    commands: string[];
  };
  native?: NativeStatus;
  /** The schema the server's fence checks, when it does not pass. */
  schema?: SchemaStatus;
  /** The server's release catalogs, each against a rebuild from its releases. */
  releaseCatalogs?: ReleaseCatalogStatus;
  /** Where each `secret:` reference in the config is read from. */
  secrets?: SecretsStatus;
  /** Where each name the config's `secretEnv` reads comes from. */
  secretEnv?: SecretEnvStatus;
  /** The Play service account's access to each Android package. */
  googlePlay?: GooglePlayStatus;

  // Package info
  packageJsonPath?: string;
  installedHotUpdaterPackages?: string[];

  // Future extensibility - can add more checks here
  // e.g., configurationIssues?: ConfigIssue[];
  // e.g., compatibilityWarnings?: Warning[];
}

interface DoctorResult {
  success: boolean;
  error?: string;
  details?: DoctorDetails;
}

interface DoctorOptions extends VerificationOptions {
  cwd?: string;
  serverBaseUrl?: string;
  fetch?: typeof fetch;
}

interface HandleDoctorOptions extends VerificationOptions {
  serverBaseUrl?: string;
  json?: boolean;
}

const FINGERPRINT_RECOVERY_COMMANDS = [
  "npx hot-updater fingerprint create",
] as const;

const EXPORT_PUBLIC_KEY_COMMANDS = [
  "npx hot-updater keys export-public",
] as const;

const REMOVE_PUBLIC_KEY_COMMANDS = ["npx hot-updater keys remove"] as const;

/**
 * Checks if two versions (or version and range) are compatible.
 * @param versionA - First version or range string.
 * @param versionB - Second version or range string.
 * @returns True if compatible, false otherwise.
 */
export function areVersionsCompatible(
  versionA: string,
  versionB: string,
): boolean {
  if (versionA === versionB) {
    return true;
  }

  const normalizedRangeA = normalizeRange(versionA);
  const normalizedRangeB = normalizeRange(versionB);
  const parsedVersionA = normalizedRangeA
    ? findMinimumForRange(normalizedRangeA)
    : null;
  const parsedVersionB = normalizedRangeB
    ? findMinimumForRange(normalizedRangeB)
    : null;
  const prereleaseChannelA = parsedVersionA?.prerelease?.[0];
  const prereleaseChannelB = parsedVersionB?.prerelease?.[0];

  if (
    parsedVersionA &&
    parsedVersionB &&
    parsedVersionA.major === parsedVersionB.major &&
    parsedVersionA.minor === parsedVersionB.minor &&
    parsedVersionA.patch === parsedVersionB.patch &&
    prereleaseChannelA !== undefined &&
    prereleaseChannelA === prereleaseChannelB
  ) {
    return true;
  }

  if (
    parsedVersionA &&
    parsedVersionB &&
    (parsedVersionA.prerelease?.length ?? 0) === 0 &&
    (parsedVersionB.prerelease?.length ?? 0) === 0 &&
    parsedVersionA.major === parsedVersionB.major &&
    (parsedVersionA.major > 0 || parsedVersionA.minor === parsedVersionB.minor)
  ) {
    return true;
  }

  const options = { includePrerelease: true };

  // Check if versionA satisfies versionB (when versionB is a range)
  if (
    normalize(versionA) &&
    normalizedRangeB &&
    satisfies(versionA, normalizedRangeB, options)
  ) {
    return true;
  }

  // Check if versionB satisfies versionA (when versionA is a range)
  if (
    normalize(versionB) &&
    normalizedRangeA &&
    satisfies(versionB, normalizedRangeA, options)
  ) {
    return true;
  }

  return false;
}

const toRelativePath = (cwd: string, filePath: string) =>
  path.relative(cwd, filePath);

const resolveProjectPath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

const findNativeFiles = ({
  cwd,
  platform,
  pattern,
}: {
  cwd: string;
  platform: NativePlatform;
  pattern: string | string[];
}) => {
  const platformRoot = path.join(cwd, platform);
  if (!fs.existsSync(platformRoot)) {
    return [];
  }

  return fg
    .sync(pattern, {
      cwd: platformRoot,
      absolute: true,
      onlyFiles: true,
      ignore: [
        "**/Pods/**",
        "**/build/**",
        "**/Build/**",
        "**/*.app/**",
        "**/*.xcarchive/**",
      ],
    })
    .map((filePath) => toRelativePath(cwd, filePath))
    .sort();
};

const findFirstMatchingFile = async ({
  cwd,
  files,
  patterns,
}: {
  cwd: string;
  files: string[];
  patterns: RegExp[];
}) => {
  for (const filePath of files) {
    const absolutePath = resolveProjectPath(cwd, filePath);
    const content = await fs.promises.readFile(absolutePath, "utf-8");
    if (patterns.some((pattern) => pattern.test(content))) {
      return filePath;
    }
  }

  return null;
};

/** The version the native project builds, or null when it cannot be read. */
const readNativeAppVersion = async (
  platform: NativePlatform,
): Promise<string | null> => {
  try {
    return await getNativeAppVersion(platform);
  } catch {
    return null;
  }
};

const readLocalFingerprintFile = async (cwd: string) => {
  const fingerprintJsonPath = path.join(cwd, "fingerprint.json");
  try {
    const content = await fs.promises.readFile(fingerprintJsonPath, "utf-8");
    return {
      path: "fingerprint.json",
      value: JSON.parse(content) as LocalFingerprint,
    };
  } catch {
    return null;
  }
};

const checkIosNativeStatus = async ({
  cwd,
  config,
}: {
  cwd: string;
  config: ConfigResponse;
}): Promise<{ status?: NativePlatformStatus; issues: NativeCheckIssue[] }> => {
  const configuredPaths = config.platform.ios.infoPlistPaths;
  const iosDetected =
    fs.existsSync(path.join(cwd, "ios")) || configuredPaths.length > 0;

  if (!iosDetected) {
    return { issues: [] };
  }

  const iosParser = new IosConfigParser(configuredPaths);
  const files = configuredPaths.filter((filePath) =>
    fs.existsSync(resolveProjectPath(cwd, filePath)),
  );
  const issues: NativeCheckIssue[] = [];

  if (!(await iosParser.exists())) {
    issues.push({
      type: "error",
      platform: "ios",
      code: "NATIVE_FILES_NOT_FOUND",
      message: "iOS Info.plist files were not found.",
      resolution:
        "Check platform.ios.infoPlistPaths in hot-updater.config.ts or run iOS prebuild first.",
      paths: configuredPaths,
    });
  }

  const channel = await iosParser.get("HOT_UPDATER_CHANNEL");
  const appDelegateFiles = findNativeFiles({
    cwd,
    platform: "ios",
    pattern: "**/{AppDelegate,SceneDelegate}.{swift,mm,m}",
  });

  let bundleProviderConfigured = false;
  if (appDelegateFiles.length === 0) {
    issues.push({
      type: "error",
      platform: "ios",
      code: "APP_DELEGATE_NOT_FOUND",
      message: "iOS AppDelegate or SceneDelegate file was not found.",
      resolution:
        "Add HotUpdater.bundleURL() to the app's iOS bundleURL provider.",
    });
  } else {
    const matchedFile = await findFirstMatchingFile({
      cwd,
      files: appDelegateFiles,
      patterns: [
        /HotUpdater\.bundleURL\s*\(/,
        /\[HotUpdater\s+bundleURL(?:WithBundle)?:?/,
      ],
    });
    bundleProviderConfigured = matchedFile !== null;

    if (!bundleProviderConfigured) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "MISSING_IOS_BUNDLE_PROVIDER",
        message:
          "iOS AppDelegate/SceneDelegate does not use HotUpdater.bundleURL().",
        resolution:
          "Replace the release JS bundle URL provider with HotUpdater.bundleURL().",
        paths: appDelegateFiles,
      });
    }
  }

  const appVersion = await readNativeAppVersion("ios");
  return {
    status: {
      detected: true,
      files: [...files, ...appDelegateFiles],
      ...(appVersion === null ? {} : { appVersion }),
      channel: channel.value ?? undefined,
      bundleProviderConfigured,
    },
    issues,
  };
};

const checkAndroidNativeStatus = async ({
  cwd,
  config,
}: {
  cwd: string;
  config: ConfigResponse;
}): Promise<{ status?: NativePlatformStatus; issues: NativeCheckIssue[] }> => {
  const configuredManifestPaths =
    config.platform.android.androidManifestPaths ?? [];
  const androidDetected =
    fs.existsSync(path.join(cwd, "android")) ||
    configuredManifestPaths.length > 0;

  if (!androidDetected) {
    return { issues: [] };
  }

  const androidParser = new AndroidConfigParser(configuredManifestPaths);
  const files = configuredManifestPaths.filter((filePath) =>
    fs.existsSync(resolveProjectPath(cwd, filePath)),
  );
  const issues: NativeCheckIssue[] = [];

  if (!(await androidParser.exists())) {
    issues.push({
      type: "error",
      platform: "android",
      code: "NATIVE_FILES_NOT_FOUND",
      message: "Android native config files were not found.",
      resolution:
        "Check platform.android.androidManifestPaths in hot-updater.config.ts or run Android prebuild first.",
      paths: configuredManifestPaths,
    });
  }

  const channel = await androidParser.get("com.hotupdater.CHANNEL");
  const mainApplicationFiles = findNativeFiles({
    cwd,
    platform: "android",
    pattern: "**/MainApplication.{kt,java}",
  });

  let bundleProviderConfigured = false;
  if (mainApplicationFiles.length === 0) {
    issues.push({
      type: "error",
      platform: "android",
      code: "MAIN_APPLICATION_NOT_FOUND",
      message: "Android MainApplication file was not found.",
      resolution:
        "Add HotUpdater.getJSBundleFile(applicationContext) to the Android host configuration.",
    });
  } else {
    const matchedFile = await findFirstMatchingFile({
      cwd,
      files: mainApplicationFiles,
      patterns: [
        /HotUpdater\s*(?:\.\s*Companion\s*)?\.\s*getJSBundleFile\s*\(/,
      ],
    });
    bundleProviderConfigured = matchedFile !== null;

    if (!bundleProviderConfigured) {
      issues.push({
        type: "error",
        platform: "android",
        code: "MISSING_ANDROID_BUNDLE_PROVIDER",
        message:
          "Android MainApplication does not use HotUpdater.getJSBundleFile().",
        resolution:
          "Pass HotUpdater.getJSBundleFile(applicationContext) to React Native's JS bundle provider.",
        paths: mainApplicationFiles,
      });
    }
  }

  const appVersion = await readNativeAppVersion("android");
  return {
    status: {
      detected: true,
      files: [...files, ...mainApplicationFiles],
      ...(appVersion === null ? {} : { appVersion }),
      channel: channel.value ?? undefined,
      bundleProviderConfigured,
    },
    issues,
  };
};

const toNativeIssue = (issue: SigningConfigIssue): NativeCheckIssue => {
  if (issue.code === "NATIVE_FILES_NOT_FOUND") {
    return {
      type: issue.type,
      platform: issue.platform,
      code: issue.code,
      message: issue.message,
      resolution: issue.resolution,
    };
  }

  return {
    type: issue.type,
    platform: issue.platform,
    code: issue.code,
    message: issue.message,
    resolution: issue.resolution,
    commands:
      issue.code === "ORPHAN_PUBLIC_KEY"
        ? [...REMOVE_PUBLIC_KEY_COMMANDS]
        : [...EXPORT_PUBLIC_KEY_COMMANDS],
  };
};

/**
 * The configured signer's public key, or, when doctor cannot read it, such as
 * a `remoteSigning` token only CI holds, a warning with the reason: the
 * native public keys are then not compared, rather than reported as a
 * mismatch whose resolution is a new native release.
 */
const readSigningPublicKey = async (
  config: ConfigResponse,
  cwd: string,
): Promise<{
  publicKey: string | undefined;
  issues: NativeCheckIssue[];
}> => {
  try {
    return {
      publicKey:
        (await getBundleSigningPublicKey(config.signing, { cwd })) ?? undefined,
      issues: [],
    };
  } catch (error) {
    return {
      publicKey: undefined,
      issues: [
        {
          type: "warning",
          platform: "project",
          code: "SIGNING_PUBLIC_KEY_UNAVAILABLE",
          message: `The native public keys were not checked against the configured bundle signer: ${
            error instanceof Error ? error.message : String(error)
          }`,
          resolution:
            "Run doctor where the signer's credentials are set, such as HOT_UPDATER_SIGNING_TOKEN for remoteSigning, to check the native public keys.",
        },
      ],
    };
  }
};

async function checkNativeStatus({
  cwd,
  context,
}: {
  cwd: string;
  context: DoctorContext;
}): Promise<NativeStatus | undefined> {
  const hasNativeDirectories =
    fs.existsSync(path.join(cwd, "ios")) ||
    fs.existsSync(path.join(cwd, "android"));

  if (!hasNativeDirectories) {
    const config = await loadConfig(null);
    const buildAdapter = await config.build({ cwd });
    const getNativeSigningPublicKey =
      buildAdapter.nativeBuild?.getBundleSigningPublicKey;
    if (!getNativeSigningPublicKey) {
      const unused = checkUnusedFingerprintJson(cwd, config.updateStrategy);
      return unused.length > 0
        ? { updateStrategy: config.updateStrategy, issues: unused }
        : undefined;
    }

    const [nativeSigningPublicKey, expectedSigningPublicKey] =
      await Promise.all([
        getNativeSigningPublicKey(),
        readSigningPublicKey(config, cwd),
      ]);
    const signing = await validateSigningConfig(config, {
      expectedPublicKey: expectedSigningPublicKey.publicKey,
      nativePublicKey: nativeSigningPublicKey?.publicKey ?? null,
    });
    const localFingerprint =
      config.updateStrategy === "fingerprint"
        ? await readLocalFingerprintFile(cwd)
        : null;
    return {
      updateStrategy: config.updateStrategy,
      ...(localFingerprint
        ? { fingerprintJsonPath: localFingerprint.path }
        : {}),
      issues: [
        ...expectedSigningPublicKey.issues,
        ...signing.issues.map(toNativeIssue),
        ...checkUnusedFingerprintJson(cwd, config.updateStrategy),
        ...(localFingerprint
          ? await checkFingerprintJson(
              localFingerprint.value,
              context.fingerprints,
            )
          : []),
      ],
    };
  }

  const config = await loadConfig(null);
  const localFingerprint = await readLocalFingerprintFile(cwd);
  const requireFingerprint = config.updateStrategy === "fingerprint";
  const expectedSigningPublicKey = await readSigningPublicKey(config, cwd);

  const [ios, android, signing] = await Promise.all([
    checkIosNativeStatus({ cwd, config }),
    checkAndroidNativeStatus({ cwd, config }),
    validateSigningConfig(config, {
      expectedPublicKey: expectedSigningPublicKey.publicKey,
    }),
  ]);

  const issues = [
    ...ios.issues,
    ...android.issues,
    ...expectedSigningPublicKey.issues,
    ...signing.issues.map(toNativeIssue),
    ...checkUnusedFingerprintJson(cwd, config.updateStrategy),
  ];

  if (requireFingerprint && localFingerprint) {
    issues.push(
      ...(await checkFingerprintJson(
        localFingerprint.value,
        context.fingerprints,
      )),
    );
  }

  if (requireFingerprint && !localFingerprint) {
    issues.push({
      type: "error",
      platform: "project",
      code: "MISSING_FINGERPRINT_JSON",
      message: "fingerprint.json is missing for fingerprint update strategy.",
      resolution: "Run `npx hot-updater fingerprint create`.",
      commands: [...FINGERPRINT_RECOVERY_COMMANDS],
      paths: ["fingerprint.json"],
    });
  }

  return {
    updateStrategy: config.updateStrategy,
    fingerprintJsonPath: localFingerprint?.path,
    ios: ios.status,
    android: android.status,
    issues,
  };
}

/** The server's release catalogs, when hot-updater.config.ts names a database. */
async function checkServer(
  context: DoctorContext,
): Promise<ReleaseCatalogStatus | undefined> {
  let server: Awaited<ReturnType<DoctorContext["server"]>>;
  try {
    server = await context.server();
  } catch (error) {
    return releaseCatalogsUnchecked(error);
  }
  return server === null ? undefined : await checkServerData(server.core);
}

/**
 * A warning for each client plugin a server plugin needs that the app does
 * not add to `HotUpdater.init({ plugins })`: the plugins
 * hot-updater.config.ts lists, as the server runs them.
 */
async function checkClientPlugins({
  cwd,
  context,
}: {
  cwd: string;
  context: DoctorContext;
}): Promise<NativeCheckIssue[]> {
  let missing: readonly PluginClientPlugin[];
  try {
    const server = await context.server();
    if (server === null) return [];
    missing = await findMissingClientPlugins({
      clientPlugins: server.clientPlugins,
      cwd,
    });
  } catch (error) {
    return [
      {
        type: "warning",
        platform: "project",
        code: "CLIENT_PLUGINS_UNCHECKED",
        message: `Could not read the plugins in hot-updater.config.ts to check the app's client plugins: ${error instanceof Error ? error.message : String(error)}`,
        resolution:
          "Check that plugins in hot-updater.config.ts load, then rerun doctor.",
      },
    ];
  }
  return missing.map(({ module, name }) => ({
    type: "warning",
    platform: "project",
    code: "MISSING_CLIENT_PLUGIN",
    message: `The server runs a plugin whose client plugin ${name} the app does not add.`,
    resolution: `Import { ${name} } from "${module}" and pass ${name}() to HotUpdater.init({ plugins }).`,
  }));
}

/** Runs every check once: true when there is nothing to report. */
async function checkProject(
  options: DoctorOptions,
  context: DoctorContext,
): Promise<true | DoctorResult> {
  try {
    const { cwd = getCwd(), serverBaseUrl, fetch: fetchImpl } = options;

    if (hasVerificationOptions(options)) {
      const verification = await verifyInfrastructure({ ...options, cwd });
      return {
        success:
          verification.checks.length > 0 &&
          verification.checks.every((check) => check.status === "pass"),
        details: { verification },
      };
    }

    // Read package.json
    const packageResult = await readPackageUp<PackageJson>(cwd);

    if (!packageResult) {
      return {
        success: false,
        error: "Could not find package.json",
      };
    }

    const packageJson = packageResult.packageJson as PackageJson;
    const packageJsonPath = packageResult.path;

    // Merge all dependencies
    const allDependencies = merge(
      packageJson.dependencies ?? {},
      packageJson.devDependencies ?? {},
    );

    // Check hot-updater version
    const hotUpdaterVersion = allDependencies["hot-updater"];

    if (!hotUpdaterVersion) {
      return {
        success: false,
        error: "hot-updater CLI not found. Please install it first.",
      };
    }

    // Find all @hot-updater packages
    const hotUpdaterPackages = Object.keys(allDependencies).filter((key) =>
      key.startsWith("@hot-updater/"),
    );
    const hasReactNativePackage =
      allDependencies["@hot-updater/react-native"] !== undefined;

    // Check for version mismatches
    const versionMismatches: VersionMismatch[] = [];

    for (const packageName of hotUpdaterPackages) {
      const currentVersion = allDependencies[packageName];
      if (
        hotUpdaterVersion &&
        currentVersion &&
        !areVersionsCompatible(currentVersion, hotUpdaterVersion)
      ) {
        versionMismatches.push({
          packageName,
          currentVersion,
          expectedVersion: hotUpdaterVersion,
        });
      }
    }

    // Build details object
    const details: DoctorDetails = {
      hotUpdaterVersion,
      packageJsonPath,
      installedHotUpdaterPackages: hotUpdaterPackages,
    };

    // Without --server-base-url, the server an agent scaffold records.
    const records = serverBaseUrl ? [] : await context.scaffolds();
    const recorded = recordedBaseUrls(records);
    const baseUrl =
      serverBaseUrl ?? (recorded.length === 1 ? recorded[0] : undefined);
    if (baseUrl) {
      const requiredTarget = getRequiredUpdateTarget(packageJsonData.version);
      details.infrastructure = {
        ...(await checkInfrastructureStatus({
          serverBaseUrl: baseUrl,
          fetchImpl,
          requiredTarget,
        })),
        ...(serverBaseUrl
          ? {}
          : {
              recordedIn: path.join(
                records.find(
                  (record) => record.baseUrl?.replace(/\/+$/u, "") === baseUrl,
                )!.dir,
                "deployment.json",
              ),
            }),
      };
    } else {
      details.infrastructureUnchecked = {
        message:
          recorded.length === 0
            ? "The server's version was not checked: doctor was given no --server-base-url, and no agent infrastructure scaffold in hot-updater-infra/ records the server."
            : `The server's version was not checked: the agent infrastructure scaffolds in hot-updater-infra/ record more than one server (${recorded.join(", ")}).`,
        resolution:
          "Run doctor with --server-base-url and the baseURL the app passes to HotUpdater.init, to check that the server runs the release this CLI needs.",
        commands: ["npx hot-updater doctor --server-base-url <url>"],
      };
    }

    if (hasReactNativePackage) {
      details.native = await checkNativeStatus({ cwd, context });
      const clientPluginIssues = await checkClientPlugins({ cwd, context });
      if (clientPluginIssues.length > 0) {
        details.native = {
          updateStrategy: (await loadConfig(null)).updateStrategy,
          ...details.native,
          issues: [...(details.native?.issues ?? []), ...clientPluginIssues],
        };
      }
    }

    // Rows to read, never a failure: a config that doesn't load is reported
    // by the checks that need it, and an adapter that can't be read is a row.
    const config = await loadConfig(null).catch(() => undefined);
    if (config) {
      const secrets = await checkSecrets(config, cwd);
      if (secrets) details.secrets = secrets;
      const googlePlay = await checkGooglePlay(config, {
        cwd,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }).catch(() => undefined);
      if (googlePlay) details.googlePlay = googlePlay;
      const secretEnv = await checkSecretEnv(config, {
        cwd,
        // Read only with a team store: the provider's own init lists them.
        managedSecrets: async () => {
          const managed = await context.managed();
          if (managed === null) return [];
          const provider = await INIT_PROVIDER_PACKAGES[managed.provider]
            .load()
            .catch(() => null);
          return provider?.initProvider.secrets ?? [];
        },
      }).catch(() => undefined);
      if (secretEnv) {
        const initCommand =
          secretEnv.processEnvReads.length === 0
            ? undefined
            : secretEnvInitCommand({
                managed: await context.managed(),
                scaffolds: await context.scaffolds(),
              });
        details.secretEnv =
          initCommand === undefined ? secretEnv : { ...secretEnv, initCommand };
      }
    }

    // The server's data reads through the fence, so it is checked once the
    // schema passes.
    const schema = await checkSchema(context);
    if (schema) {
      details.schema = schema;
    } else {
      const releaseCatalogs = await checkServer(context);
      if (releaseCatalogs) details.releaseCatalogs = releaseCatalogs;
    }

    // Named once the schema is known: an upgrade migrates the database.
    if (
      details.infrastructure &&
      (details.infrastructure.error !== undefined ||
        details.infrastructure.needsUpdate === true ||
        details.infrastructure.upgradeBlocked === true)
    ) {
      details.infrastructure.remediation = createInfrastructureRemediation({
        upgradeBlocked: details.infrastructure.upgradeBlocked,
        requiredVersion: details.infrastructure.requiredVersion,
        managed: await context.managed(),
        scaffold: await context.scaffoldUpgrade(),
        schemaBlockers: [
          ...new Set(
            (schema?.issues ?? [])
              .filter(({ code }) => code !== "SCHEMA_MIGRATION_PENDING")
              .map(({ code }) => code),
          ),
        ],
      });
    }

    // Add version mismatches if any
    if (versionMismatches.length > 0) {
      details.versionMismatches = versionMismatches;
    }

    // Check if there are any issues
    const hasInfrastructureIssue =
      details.infrastructure?.error !== undefined ||
      details.infrastructure?.needsUpdate === true ||
      details.infrastructure?.upgradeBlocked === true;
    const hasNativeIssue =
      details.native?.issues.some((issue) => issue.type === "error") === true;
    const hasServerDataIssue = [
      ...(details.schema?.issues ?? []),
      ...(details.releaseCatalogs?.issues ?? []),
    ].some((issue) => issue.type === "error");
    const hasIssues =
      versionMismatches.length > 0 ||
      hasInfrastructureIssue ||
      hasNativeIssue ||
      hasServerDataIssue;
    // Future: || configurationIssues.length > 0 || etc.

    if (hasIssues) {
      return {
        success: false,
        details,
      };
    }

    if (details.infrastructure) {
      return {
        success: true,
        details,
      };
    }

    if (
      details.native ||
      details.schema ||
      details.releaseCatalogs ||
      details.secrets ||
      details.secretEnv ||
      details.googlePlay ||
      details.infrastructureUnchecked
    ) {
      return {
        success: true,
        details,
      };
    }

    // Everything is healthy
    return true;
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

const normalizeDoctorResult = (result: true | DoctorResult): DoctorResult => {
  if (result === true) {
    return { success: true };
  }

  return result;
};

/**
 * Performs health check on Hot Updater installation
 * @param options - Doctor check options
 * @returns true if everything is healthy, or DoctorResult with details if there are issues
 */
export async function doctor(
  options: DoctorOptions = {},
): Promise<true | DoctorResult> {
  // One server and one fingerprint for the whole run, closed once at its end.
  const context = createDoctorContext(options.cwd ?? getCwd());
  try {
    return await checkProject(options, context);
  } finally {
    await context.dispose();
  }
}

const promptServerBaseUrl = async () => {
  if (nonInteractiveReason() !== undefined || !process.stdout.isTTY) {
    return undefined;
  }

  const serverBaseUrl = await p.text({
    message: "Server base URL for infrastructure check (Enter to skip)",
    placeholder: "https://updates.example.com",
    validate(value) {
      const trimmed = value?.trim() ?? "";
      if (!trimmed) return;

      try {
        new URL(trimmed);
      } catch {
        return "Enter a valid URL";
      }

      return;
    },
  });

  if (p.isCancel(serverBaseUrl)) {
    p.cancel("Doctor check cancelled");
    process.exit(0);
  }

  const trimmed = serverBaseUrl.trim();
  return trimmed ? trimmed : undefined;
};

/** Each issue and its resolution, which `--json` prints as they are, as one entry. */
const reportIssues = (
  issues: readonly {
    readonly type: "error" | "warning";
    readonly message: string;
    readonly resolution: string;
  }[],
) => {
  for (const issue of issues) {
    const report = issue.type === "error" ? p.log.error : p.log.warn;
    report(`${ui.prose(issue.message)}\n${ui.prose(issue.resolution)}`);
  }
};

export const handleDoctor = async ({
  serverBaseUrl,
  json = false,
  ...verificationOptions
}: HandleDoctorOptions = {}) => {
  if (json) {
    const result = normalizeDoctorResult(
      await doctor({
        serverBaseUrl,
        ...verificationOptions,
      }),
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exit(1);
    }
    return;
  }

  p.intro("Hot Updater doctor");

  // A server an agent scaffold records is checked without asking.
  const resolvedServerBaseUrl =
    hasVerificationOptions(verificationOptions) ||
    serverBaseUrl !== undefined ||
    recordedBaseUrls(await findScaffoldDeployments(getCwd())).length === 1
      ? serverBaseUrl
      : await promptServerBaseUrl();
  const result = await doctor({
    serverBaseUrl: resolvedServerBaseUrl,
    ...verificationOptions,
  });

  if (result === true) {
    p.log.success("All checks passed.");
    p.outro("Healthy.");
    return;
  }

  // Handle errors
  if (result.error) {
    p.log.error(result.error);
    p.outro("Doctor check failed.");
    // Match the --json path and the issue path below, which both exit non-zero.
    process.exit(1);
  }

  // Handle issues with details
  const { details } = result;
  const shouldExitWithFailure = !result.success;

  if (details?.verification) {
    const { scope, checks, notChecked } = details.verification;
    p.log.step(ui.block("Verification", [ui.kv("Scope", scope)]));
    for (const check of checks) {
      const message = [
        ui.prose(`${check.status} ${check.code} ${check.message}`),
        check.paths?.length
          ? check.paths.map((file) => ui.path(ui.fitPath(file))).join("\n")
          : "",
        check.resolution ? ui.prose(check.resolution) : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (check.status === "pass") p.log.success(message);
      else p.log.error(message);
    }
    p.log.info(ui.prose(`Not checked: ${notChecked.join(", ")}`));
    if (!result.success) process.exit(1);
    p.outro(`${scope} checks passed.`);
    return;
  }

  if (details?.hotUpdaterVersion) {
    p.log.step(
      ui.block("Version", [
        ui.kv("CLI", ui.version(details.hotUpdaterVersion)),
      ]),
    );
  }

  if (details?.infrastructureUnchecked) {
    const [command] = details.infrastructureUnchecked.commands;
    // --json keeps the message and resolution; the command says the rest.
    p.log.warn(
      [
        "Server version not checked.",
        command ? ui.withCommand("To check it:", command) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (details?.infrastructure) {
    const infrastructure = details.infrastructure;
    p.log.step(
      ui.block("Infrastructure", [
        ui.kv("Endpoint", ui.path(infrastructure.versionEndpoint)),
        infrastructure.recordedIn &&
          ui.kv("Recorded in", ui.path(ui.fitPath(infrastructure.recordedIn))),
        infrastructure.serverVersion &&
          ui.kv("Server", ui.version(infrastructure.serverVersion)),
        infrastructure.serverVersion &&
          ui.kv("Required", ui.version(infrastructure.requiredVersion)),
        infrastructure.infrastructureGeneration !== undefined &&
          ui.kv("Generation", String(infrastructure.infrastructureGeneration)),
      ]),
    );

    const reason = infrastructure.updateReason
      ? `\n${ui.prose(infrastructure.updateReason)}`
      : "";
    if (infrastructure.upgradeBlocked) {
      p.log.error(
        `In-place v0 to v1 infrastructure upgrade is not supported.${reason}`,
      );
    } else if (infrastructure.needsUpdate) {
      p.log.error(
        `Infrastructure update required: ${infrastructure.requiredVersion}+${reason}`,
      );
    } else if (infrastructure.error) {
      p.log.error(
        ui.prose(`Infrastructure check failed: ${infrastructure.error}`),
      );
    } else {
      p.log.success("Infrastructure is up to date.");
    }

    if (infrastructure.catalogMode) {
      p.log.info(
        ui.prose(
          `Release catalog: ${infrastructure.catalogMode}. ${infrastructure.catalogModeNote}`,
        ),
      );
    }

    // The schema check below names the same commands when the upgrade is
    // the migration it reports: they are printed once, there.
    const schemaCommands = new Set(
      details.schema?.issues.flatMap(({ commands }) => commands ?? []) ?? [],
    );
    const repeated =
      infrastructure.remediation !== undefined &&
      infrastructure.remediation.commands.length > 0 &&
      infrastructure.remediation.commands.every((command) =>
        schemaCommands.has(command),
      );
    if (infrastructure.remediation && !repeated) {
      p.log.info(
        [
          ui.prose(infrastructure.remediation.reason),
          ...infrastructure.remediation.commands.map((command) =>
            ui.commandLines(command),
          ),
        ].join("\n"),
      );
    }
  }

  if (details?.native) {
    const native = details.native;
    const platformRows = (
      label: string,
      platform: NativeStatus["ios"] | NativeStatus["android"],
    ): MaybeRow[] =>
      platform?.detected
        ? [
            ui.kv(label, ui.status(platform.bundleProviderConfigured === true)),
            platform.appVersion &&
              ui.kv(`${label} app version`, ui.version(platform.appVersion)),
            platform.channel &&
              ui.kv(`${label} channel`, ui.channel(platform.channel)),
          ]
        : [];
    p.log.step(
      ui.block("Native", [
        ui.kv("Strategy", native.updateStrategy),
        ...platformRows("iOS", native.ios),
        ...platformRows("Android", native.android),
      ]),
    );

    for (const issue of native.issues) {
      const message = ui.prose(`${issue.platform}: ${issue.message}`);
      const report = issue.type === "error" ? p.log.error : p.log.warn;
      if (issue.changes) {
        report(message);
        showFingerprintChanges(
          issue.changes,
          issue.platform === "ios" ? "iOS" : "Android",
        );
        p.log.info(ui.prose(issue.resolution));
      } else {
        report(`${message}\n${ui.prose(issue.resolution)}`);
      }
    }
  }

  if (details?.secrets || details?.secretEnv) {
    const { secrets, secretEnv } = details;
    const adapter =
      secrets?.adapter ?? secretEnv?.adapter ?? LOCAL_SECRETS_NAME;
    // The `secret:` references, then the names `secretEnv` reads, each with
    // where a command finds it.
    const rows = [...(secrets?.references ?? []), ...(secretEnv?.names ?? [])];
    if (rows.length > 0) {
      p.log.step(
        ui.block("Secrets", [
          ui.kv("Adapter", adapter),
          ...rows.map(({ name, source, inAdapter }) =>
            ui.kv(
              name,
              source === "environment"
                ? inAdapter === false
                  ? ui.warning("set by the environment, none in the adapter")
                  : "set by the environment"
                : source === "adapter"
                  ? "in the adapter"
                  : source === "missing"
                    ? ui.warning("missing")
                    : "not checked",
            ),
          ),
        ]),
      );
    }
    for (const error of new Set(
      [secrets?.error, secretEnv?.error].filter(
        (error): error is string => error !== undefined,
      ),
    )) {
      p.log.warn(
        ui.prose(`Couldn't read the ${adapter} secrets adapter: ${error}`),
      );
    }
    const processEnvReads = secretEnv?.processEnvReads ?? [];
    if (processEnvReads.length > 0) {
      const them = processEnvReads.length === 1 ? "it" : "them";
      p.log.warn(
        [
          ui.prose(
            `hot-updater.config.ts reads ${processEnvReads.join(", ")} with process.env, so ${adapter} never supplies ${them}.`,
          ),
          ...secretEnvAdvice(them, secretEnv?.initCommand),
        ].join("\n"),
      );
    }
  }

  if (details?.googlePlay) {
    const { ready, text } = formatGooglePlayStatus(details.googlePlay);
    (ready ? p.log.step : p.log.warn)(text);
  }

  if (details?.schema) {
    p.log.step(
      ui.block(
        "Schema",
        details.schema.settings.map(({ key, expected, found }) => [
          key,
          `${found === null ? "missing" : ui.version(found)} → ${ui.version(expected)}`,
        ]),
      ),
    );
    reportIssues(details.schema.issues);
  }

  if (details?.releaseCatalogs) {
    const { scopes, issues } = details.releaseCatalogs;
    p.log.step(
      ui.block("Release catalogs", [
        ui.kv("Scopes", String(scopes.length)),
        ui.kv(
          "Verified",
          String(scopes.filter(({ state }) => state === "verified").length),
        ),
      ]),
    );
    reportIssues(issues);
  }

  if (details?.versionMismatches && details.versionMismatches.length > 0) {
    p.log.error(
      ui.block(
        "Version mismatches",
        details.versionMismatches.map((mismatch) => [
          mismatch.packageName,
          `${mismatch.currentVersion} (expected ${mismatch.expectedVersion})`,
        ]),
      ),
    );
  }

  if (shouldExitWithFailure) process.exit(1);

  p.log.success("All checks passed.");
  p.outro("Doctor complete.");
};
