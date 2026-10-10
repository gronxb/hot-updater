import fs from "fs";
import path from "path";

import {
  type ConfigResponse,
  getBundleSigningPublicKey,
  getCwd,
  loadConfig,
  p,
  readPackageUp,
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
import { ui } from "../utils/cli-ui";
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
import { checkFingerprintJson } from "./doctor/fingerprint";
import { applyDoctorFixes } from "./doctor/fix";
import {
  type ArtifactStatus,
  type DoctorFix,
  fixesWroteNativeFiles,
  type NativeCheckIssue,
  type NativePlatform,
  type ReleaseCatalogStatus,
} from "./doctor/issues";
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
  fingerprintHash?: string;
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
  /** What `--fix` repaired, with every file it wrote; checks ran again after it. */
  fixes?: DoctorFix[];
  // Version related
  hotUpdaterVersion?: string;
  versionMismatches?: VersionMismatch[];
  infrastructure?: InfrastructureStatus;
  native?: NativeStatus;
  /** The server's release catalogs, each against a rebuild from its releases. */
  releaseCatalogs?: ReleaseCatalogStatus;
  /** The server's artifact records against the releases that use them. */
  artifacts?: ArtifactStatus;

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
  /** Runs every repair doctor can do itself, then checks again. */
  fix?: boolean;
}

interface HandleDoctorOptions extends VerificationOptions {
  serverBaseUrl?: string;
  json?: boolean;
  fix?: boolean;
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
  requireFingerprint,
  expectedFingerprintHash,
}: {
  cwd: string;
  config: ConfigResponse;
  requireFingerprint: boolean;
  expectedFingerprintHash?: string;
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
      fixability: "auto",
      paths: configuredPaths,
    });
  }

  const channel = await iosParser.get("HOT_UPDATER_CHANNEL");
  const fingerprintHash = requireFingerprint
    ? await iosParser.get("HOT_UPDATER_FINGERPRINT_HASH")
    : undefined;

  if (requireFingerprint && !fingerprintHash?.value) {
    issues.push({
      type: "error",
      platform: "ios",
      code: "MISSING_FINGERPRINT_HASH",
      message: "HOT_UPDATER_FINGERPRINT_HASH is missing from Info.plist.",
      resolution:
        "Run `npx hot-updater fingerprint create` or rebuild through the Expo config plugin.",
      fixability: "command",
      commands: [...FINGERPRINT_RECOVERY_COMMANDS],
      paths: fingerprintHash?.paths.length ? fingerprintHash.paths : files,
    });
  } else if (
    requireFingerprint &&
    expectedFingerprintHash &&
    fingerprintHash?.value !== expectedFingerprintHash
  ) {
    issues.push({
      type: "error",
      platform: "ios",
      code: "FINGERPRINT_HASH_MISMATCH",
      message: "HOT_UPDATER_FINGERPRINT_HASH does not match fingerprint.json.",
      resolution:
        "Run `npx hot-updater fingerprint create` and rebuild your iOS app.",
      fixability: "command",
      commands: [...FINGERPRINT_RECOVERY_COMMANDS],
      paths: fingerprintHash?.paths ?? files,
    });
  }

  const appDelegateFiles = findNativeFiles({
    cwd,
    platform: "ios",
    pattern: "**/AppDelegate.{swift,mm,m}",
  });

  let bundleProviderConfigured = false;
  if (appDelegateFiles.length === 0) {
    issues.push({
      type: "error",
      platform: "ios",
      code: "APP_DELEGATE_NOT_FOUND",
      message: "iOS AppDelegate file was not found.",
      resolution:
        "Add HotUpdater.bundleURL() to the app's iOS bundleURL provider.",
      fixability: "auto",
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
        message: "iOS AppDelegate does not use HotUpdater.bundleURL().",
        resolution:
          "Replace the release JS bundle URL provider with HotUpdater.bundleURL().",
        fixability: "auto",
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
      fingerprintHash: fingerprintHash?.value ?? undefined,
      bundleProviderConfigured,
    },
    issues,
  };
};

const checkAndroidNativeStatus = async ({
  cwd,
  config,
  requireFingerprint,
  expectedFingerprintHash,
}: {
  cwd: string;
  config: ConfigResponse;
  requireFingerprint: boolean;
  expectedFingerprintHash?: string;
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
      fixability: "auto",
      paths: configuredManifestPaths,
    });
  }

  const channel = await androidParser.get("com.hotupdater.CHANNEL");
  const fingerprintHash = requireFingerprint
    ? await androidParser.get("com.hotupdater.FINGERPRINT_HASH")
    : undefined;

  if (requireFingerprint && !fingerprintHash?.value) {
    issues.push({
      type: "error",
      platform: "android",
      code: "MISSING_FINGERPRINT_HASH",
      message:
        "com.hotupdater.FINGERPRINT_HASH is missing from AndroidManifest.xml.",
      resolution:
        "Run `npx hot-updater fingerprint create` or rebuild through the Expo config plugin.",
      fixability: "command",
      commands: [...FINGERPRINT_RECOVERY_COMMANDS],
      paths: fingerprintHash?.paths.length ? fingerprintHash.paths : files,
    });
  } else if (
    requireFingerprint &&
    expectedFingerprintHash &&
    fingerprintHash?.value !== expectedFingerprintHash
  ) {
    issues.push({
      type: "error",
      platform: "android",
      code: "FINGERPRINT_HASH_MISMATCH",
      message:
        "com.hotupdater.FINGERPRINT_HASH in AndroidManifest.xml does not match fingerprint.json.",
      resolution:
        "Run `npx hot-updater fingerprint create` and rebuild your Android app.",
      fixability: "command",
      commands: [...FINGERPRINT_RECOVERY_COMMANDS],
      paths: fingerprintHash?.paths ?? files,
    });
  }

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
      fixability: "auto",
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
        fixability: "auto",
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
      fingerprintHash: fingerprintHash?.value ?? undefined,
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
      fixability: "auto",
    };
  }

  return {
    type: issue.type,
    platform: issue.platform,
    code: issue.code,
    message: issue.message,
    resolution: issue.resolution,
    fixability: "command",
    commands:
      issue.code === "ORPHAN_PUBLIC_KEY"
        ? [...REMOVE_PUBLIC_KEY_COMMANDS]
        : [...EXPORT_PUBLIC_KEY_COMMANDS],
  };
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
    if (!getNativeSigningPublicKey) return undefined;

    const [nativeSigningPublicKey, expectedSigningPublicKey] =
      await Promise.all([
        getNativeSigningPublicKey(),
        getBundleSigningPublicKey(config.signing, { cwd }).catch(
          () => "invalid configured bundle signing public key",
        ),
      ]);
    const signing = await validateSigningConfig(config, {
      expectedPublicKey: expectedSigningPublicKey ?? undefined,
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
        ...signing.issues.map(toNativeIssue),
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
  const expectedSigningPublicKey =
    (await getBundleSigningPublicKey(config.signing, { cwd }).catch(
      () => "invalid configured bundle signing public key",
    )) ?? undefined;

  const [ios, android, signing] = await Promise.all([
    checkIosNativeStatus({
      cwd,
      config,
      requireFingerprint,
      expectedFingerprintHash: localFingerprint?.value.ios?.hash,
    }),
    checkAndroidNativeStatus({
      cwd,
      config,
      requireFingerprint,
      expectedFingerprintHash: localFingerprint?.value.android?.hash,
    }),
    validateSigningConfig(config, {
      expectedPublicKey: expectedSigningPublicKey,
    }),
  ]);

  const issues = [
    ...ios.issues,
    ...android.issues,
    ...signing.issues.map(toNativeIssue),
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
      fixability: "command",
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

/**
 * The server's release catalogs and artifact records, when
 * hot-updater.config.ts names a database.
 */
async function checkServer(context: DoctorContext): Promise<{
  releaseCatalogs?: ReleaseCatalogStatus;
  artifacts?: ArtifactStatus;
}> {
  let server: Awaited<ReturnType<DoctorContext["server"]>>;
  try {
    server = await context.server();
  } catch (error) {
    return { releaseCatalogs: releaseCatalogsUnchecked(error) };
  }
  return server === null ? {} : await checkServerData(server.core);
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
        fixability: "blocked",
      },
    ];
  }
  return missing.map(({ module, name }) => ({
    type: "warning",
    platform: "project",
    code: "MISSING_CLIENT_PLUGIN",
    message: `The server runs a plugin whose client plugin ${name} the app does not add.`,
    resolution: `Import { ${name} } from "${module}" and pass ${name}() to HotUpdater.init({ plugins }).`,
    fixability: "auto",
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

    if (serverBaseUrl) {
      const requiredTarget = getRequiredUpdateTarget(packageJsonData.version);
      details.infrastructure = await checkInfrastructureStatus({
        serverBaseUrl,
        fetchImpl,
        requiredTarget,
      });

      if (
        details.infrastructure.error !== undefined ||
        details.infrastructure.needsUpdate === true ||
        details.infrastructure.upgradeBlocked === true
      ) {
        details.infrastructure.remediation = createInfrastructureRemediation({
          upgradeBlocked: details.infrastructure.upgradeBlocked,
        });
      }
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

    const { releaseCatalogs, artifacts } = await checkServer(context);
    if (releaseCatalogs) details.releaseCatalogs = releaseCatalogs;
    if (artifacts) details.artifacts = artifacts;

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
      ...(details.releaseCatalogs?.issues ?? []),
      ...(details.artifacts?.issues ?? []),
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

    if (details.native || details.releaseCatalogs || details.artifacts) {
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
    const result = await checkProject(options, context);
    // Scoped verification never repairs: the CLI refuses --fix with its
    // options, and a caller that passes both gets the verification alone.
    if (!options.fix || hasVerificationOptions(options)) return result;

    // --fix runs the repairs the first checks call for, then checks again,
    // so the result describes the project after them.
    const before = normalizeDoctorResult(result);
    if (before.error !== undefined) return before;
    const fixes = await applyDoctorFixes(
      [
        ...(before.details?.native?.issues ?? []),
        ...(before.details?.releaseCatalogs?.issues ?? []),
        ...(before.details?.artifacts?.issues ?? []),
      ],
      context,
    );
    const after = fixes.some(({ status }) => status === "applied")
      ? normalizeDoctorResult(await checkProject(options, context))
      : before;
    return { ...after, details: { ...after.details, fixes } };
  } finally {
    await context.dispose();
  }
}

const promptServerBaseUrl = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
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

const FIX_DESCRIPTIONS: Record<DoctorFix["repair"], string> = {
  fingerprint: "Recreate fingerprint.json and the native fingerprint hashes",
  "public-key": "Write the configured public key into the native files",
  "orphan-public-key": "Remove the public key from the native files",
  "release-catalogs": "Rebuild the stale release catalogs from their releases",
  "unreferenced-artifacts": "Delete the artifact records no release uses",
};

/** What each repair's writes are, in its output. */
const WROTE_LABELS: Record<DoctorFix["repair"], string> = {
  fingerprint: "Path",
  "public-key": "Path",
  "orphan-public-key": "Path",
  "release-catalogs": "Catalog",
  "unreferenced-artifacts": "Artifact",
};

const REBUILD_NATIVE_APP =
  "Rebuild the native app: doctor --fix changed its native files.";

/** What `--fix` did: each repair, every file it wrote, or why it did not. */
const printFixes = (fixes: readonly DoctorFix[]) => {
  if (fixes.length === 0) {
    p.log.info("--fix found nothing it can repair.");
    return;
  }
  for (const fix of fixes) {
    const description = FIX_DESCRIPTIONS[fix.repair];
    if (fix.status === "applied") {
      p.log.success(`Fixed: ${description}.`);
      p.log.message(
        ui.block(
          "Wrote",
          fix.wrote.map((written) =>
            WROTE_LABELS[fix.repair] === "Path"
              ? ui.kv("Path", ui.path(written))
              : ui.kv(WROTE_LABELS[fix.repair], written),
          ),
        ),
      );
      if (fix.note) p.log.warn(fix.note);
    } else if (fix.status === "skipped") {
      p.log.warn(`Skipped: ${description}. ${fix.note ?? ""}`.trim());
    } else {
      p.log.error(`Failed: ${description}. ${fix.note ?? ""}`.trim());
    }
  }
};

export const handleDoctor = async ({
  serverBaseUrl,
  json = false,
  fix = false,
  ...verificationOptions
}: HandleDoctorOptions = {}) => {
  if (json) {
    const result = normalizeDoctorResult(
      await doctor({ serverBaseUrl, fix, ...verificationOptions }),
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exit(1);
    }
    return;
  }

  p.intro("Hot Updater doctor");

  const resolvedServerBaseUrl = hasVerificationOptions(verificationOptions)
    ? serverBaseUrl
    : (serverBaseUrl ?? (await promptServerBaseUrl()));
  const result = await doctor({
    serverBaseUrl: resolvedServerBaseUrl,
    fix,
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
  let shouldExitWithFailure = !result.success;

  if (details?.fixes) printFixes(details.fixes);

  if (details?.verification) {
    const { scope, checks, notChecked } = details.verification;
    p.log.message(ui.block("Verification", [ui.kv("Scope", scope)]));
    for (const check of checks) {
      const message = ui.line([check.status, check.code, check.message]);
      if (check.status === "pass") p.log.success(message);
      else p.log.error(message);
      if (check.paths?.length)
        p.log.info(check.paths.map((file) => ui.path(file)).join(", "));
      if (check.resolution) p.log.info(check.resolution);
    }
    p.log.info(`Not checked: ${notChecked.join(", ")}`);
    if (!result.success) process.exit(1);
    p.outro(`${scope} checks passed.`);
    return;
  }

  if (details?.hotUpdaterVersion) {
    p.log.message(
      ui.block("Version", [
        ui.kv("CLI", ui.version(details.hotUpdaterVersion)),
      ]),
    );
  }

  if (details?.infrastructure) {
    const infrastructure = details.infrastructure;
    const lines = [ui.kv("Endpoint", ui.path(infrastructure.versionEndpoint))];

    if (infrastructure.serverVersion) {
      lines.push(ui.kv("Server", ui.version(infrastructure.serverVersion)));
      lines.push(ui.kv("Required", ui.version(infrastructure.requiredVersion)));
    }
    if (infrastructure.infrastructureGeneration !== undefined) {
      lines.push(
        ui.kv("Generation", String(infrastructure.infrastructureGeneration)),
      );
    }
    p.log.message(ui.block("Infrastructure", lines));

    if (infrastructure.upgradeBlocked) {
      p.log.error("In-place v0 to v1 infrastructure upgrade is not supported.");
      if (infrastructure.updateReason) {
        p.log.info(`Reason: ${infrastructure.updateReason}`);
      }
    } else if (infrastructure.needsUpdate) {
      p.log.error(
        `Infrastructure update required: ${infrastructure.requiredVersion}+`,
      );
      if (infrastructure.updateReason) {
        p.log.info(`Reason: ${infrastructure.updateReason}`);
      }
    } else if (infrastructure.error) {
      p.log.error(`Infrastructure check failed: ${infrastructure.error}`);
    } else {
      p.log.success("Infrastructure is up to date.");
    }

    if (infrastructure.catalogMode) {
      p.log.info(
        `Release catalog: ${infrastructure.catalogMode}. ${infrastructure.catalogModeNote}`,
      );
    }

    if (infrastructure.remediation) {
      const recoveryLines = infrastructure.remediation.commands.map(
        (command, index) =>
          ui.kv(
            index === 0 ? "Command" : `Command ${index + 1}`,
            ui.command(command),
          ),
      );
      p.log.message(ui.block("Recovery", recoveryLines));
    }
  }

  if (details?.native) {
    const native = details.native;
    const lines = [ui.kv("Strategy", native.updateStrategy)];

    if (native.ios?.detected) {
      lines.push(
        ui.kv(
          "iOS",
          native.ios.bundleProviderConfigured
            ? ui.status(true)
            : ui.status(false),
        ),
      );
      if (native.ios.appVersion) {
        lines.push(ui.kv("iOS app version", ui.version(native.ios.appVersion)));
      }
      if (native.ios.channel) {
        lines.push(ui.kv("iOS channel", ui.channel(native.ios.channel)));
      }
    }

    if (native.android?.detected) {
      lines.push(
        ui.kv(
          "Android",
          native.android.bundleProviderConfigured
            ? ui.status(true)
            : ui.status(false),
        ),
      );
      if (native.android.appVersion) {
        lines.push(
          ui.kv("Android app version", ui.version(native.android.appVersion)),
        );
      }
      if (native.android.channel) {
        lines.push(
          ui.kv("Android channel", ui.channel(native.android.channel)),
        );
      }
    }

    p.log.message(ui.block("Native", lines));

    for (const issue of native.issues) {
      const message = `${issue.platform}: ${issue.message}`;
      if (issue.type === "error") {
        p.log.error(message);
      } else {
        p.log.warn(message);
      }
      if (issue.changes) {
        showFingerprintChanges(
          issue.changes,
          issue.platform === "ios" ? "iOS" : "Android",
        );
      }
      p.log.info(issue.resolution);
    }
  }

  if (details?.releaseCatalogs) {
    const { scopes, issues } = details.releaseCatalogs;
    p.log.message(
      ui.block("Release catalogs", [
        ui.kv("Scopes", String(scopes.length)),
        ui.kv(
          "Verified",
          String(scopes.filter(({ state }) => state === "verified").length),
        ),
      ]),
    );
    for (const issue of issues) {
      if (issue.type === "error") {
        p.log.error(issue.message);
      } else {
        p.log.warn(issue.message);
      }
      p.log.info(issue.resolution);
    }
  }

  for (const issue of details?.artifacts?.issues ?? []) {
    if (issue.type === "error") {
      p.log.error(issue.message);
    } else {
      p.log.warn(issue.message);
    }
    if (issue.artifactIds) p.log.info(issue.artifactIds.join(", "));
    p.log.info(issue.resolution);
  }

  if (details?.versionMismatches && details.versionMismatches.length > 0) {
    p.log.warn("Version mismatches found:");

    for (const mismatch of details.versionMismatches) {
      p.log.error(
        `${mismatch.packageName}: ${mismatch.currentVersion} ` +
          `(expected ${mismatch.expectedVersion})`,
      );
    }
  }

  // Whenever --fix wrote native files, the last line says to rebuild.
  const rebuildNativeApp = fixesWroteNativeFiles(details?.fixes ?? []);
  if (shouldExitWithFailure) {
    if (rebuildNativeApp) p.log.warn(REBUILD_NATIVE_APP);
    process.exit(1);
  }

  p.log.success("All checks passed.");
  p.outro(rebuildNativeApp ? REBUILD_NATIVE_APP : "Doctor complete.");
};
