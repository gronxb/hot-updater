import fs from "fs";
import path from "path";

import {
  type ConfigResponse,
  getCwd,
  loadConfig,
  p,
  readPackageUp,
} from "@hot-updater/cli-tools";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import * as semver from "semver";

import { ui } from "../utils/cli-ui";
import { AndroidConfigParser } from "../utils/configParser/androidParser";
import { IosConfigParser } from "../utils/configParser/iosParser";
import {
  type SigningConfigIssue,
  validateSigningConfig,
} from "../utils/signing/validateSigningConfig";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface VersionMismatch {
  packageName: string;
  currentVersion: string;
  expectedVersion: string;
}

interface InfrastructureStatus {
  baseUrl: string;
  versionEndpoint: string;
  serverVersion?: string;
  requiredVersion: string;
  needsUpdate?: boolean;
  updateReason?: string;
  error?: string;
  remediation?: InfrastructureRemediation;
}

type DoctorFixability = "auto" | "command" | "blocked";
type NativePlatform = "ios" | "android";
type NativeIssueType = "error" | "warning";

interface NativeCheckIssue {
  type: NativeIssueType;
  platform: NativePlatform | "project";
  code:
    | "NATIVE_FILES_NOT_FOUND"
    | "APP_DELEGATE_NOT_FOUND"
    | "MAIN_APPLICATION_NOT_FOUND"
    | "MISSING_IOS_BUNDLE_PROVIDER"
    | "MISSING_ANDROID_BUNDLE_PROVIDER"
    | "MISSING_FINGERPRINT_JSON"
    | "MISSING_FINGERPRINT_HASH"
    | "FINGERPRINT_HASH_MISMATCH"
    | SigningConfigIssue["code"];
  message: string;
  resolution: string;
  fixability: DoctorFixability;
  commands?: string[];
  paths?: string[];
}

interface NativePlatformStatus {
  detected: boolean;
  files: string[];
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
  ios?: { hash?: string } | null;
  android?: { hash?: string } | null;
}

interface DoctorDetails {
  // Version related
  hotUpdaterVersion?: string;
  versionMismatches?: VersionMismatch[];
  infrastructure?: InfrastructureStatus;
  native?: NativeStatus;

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

interface DoctorOptions {
  cwd?: string;
  serverBaseUrl?: string;
  fetch?: typeof fetch;
}

interface HandleDoctorOptions {
  serverBaseUrl?: string;
  json?: boolean;
}

interface ServerVersionResponse {
  version?: unknown;
}

interface InfrastructureUpdateTarget {
  version: string;
  note: string;
}

interface InfrastructureRemediation {
  fixability: DoctorFixability;
  reason: string;
  commands: string[];
}

const INFRASTRUCTURE_RECOVERY_COMMANDS = [
  "hot-updater init",
  "hot-updater db migrate",
  "hot-updater db generate",
] as const;

const FINGERPRINT_RECOVERY_COMMANDS = [
  "npx hot-updater fingerprint create",
] as const;

const EXPORT_PUBLIC_KEY_COMMANDS = [
  "npx hot-updater keys export-public",
] as const;

const REMOVE_PUBLIC_KEY_COMMANDS = ["npx hot-updater keys remove"] as const;

// Only versions that require deployed server/infrastructure changes belong here.
// Regular package releases must not be added unless existing infrastructure needs
// to be redeployed or migrated for compatibility.
export const INFRASTRUCTURE_UPDATE_TARGETS = [
  {
    version: "0.13.0",
    note: "Initial provider infrastructure migrations",
  },
  {
    version: "0.18.0",
    note: "Provider infrastructure migration",
  },
  {
    version: "0.21.0",
    note: "ORM schema version target",
  },
  {
    version: "0.29.0",
    note: "Rollout infrastructure fields",
  },
  {
    version: "0.30.0",
    note: "Target cohort rollout behavior",
  },
  {
    version: "0.31.0",
    note: "Bundle artifact storage fields",
  },
] as const satisfies readonly [
  InfrastructureUpdateTarget,
  ...InfrastructureUpdateTarget[],
];

const getInfrastructureTargetVersionAt = (index: number): string => {
  const target = INFRASTRUCTURE_UPDATE_TARGETS.at(index);
  if (!target) {
    throw new Error("INFRASTRUCTURE_UPDATE_TARGETS must not be empty");
  }
  return target.version;
};

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

  const options = { includePrerelease: true };

  // Check if versionA satisfies versionB (when versionB is a range)
  if (
    semver.valid(versionA) &&
    semver.validRange(versionB) &&
    semver.satisfies(versionA, versionB, options)
  ) {
    return true;
  }

  // Check if versionB satisfies versionA (when versionA is a range)
  if (
    semver.valid(versionB) &&
    semver.validRange(versionA) &&
    semver.satisfies(versionB, versionA, options)
  ) {
    return true;
  }

  return false;
}

export function getRequiredInfrastructureVersion(
  hotUpdaterVersion: string = getInfrastructureTargetVersionAt(-1),
): string {
  const current = semver.coerce(hotUpdaterVersion)?.version;

  if (!current) {
    return getInfrastructureTargetVersionAt(-1);
  }

  let requiredVersion = getInfrastructureTargetVersionAt(0);

  for (const target of INFRASTRUCTURE_UPDATE_TARGETS) {
    if (semver.lte(target.version, current)) {
      requiredVersion = target.version;
    }
  }

  return requiredVersion;
}

export function isInfrastructureUpdateRequired({
  serverVersion,
  requiredVersion = getRequiredInfrastructureVersion(),
}: {
  serverVersion: string;
  requiredVersion?: string;
}): boolean {
  const normalizedServerVersion = semver.valid(serverVersion);
  const normalizedRequiredVersion = semver.valid(requiredVersion);

  if (!normalizedServerVersion || !normalizedRequiredVersion) {
    throw new Error("Invalid infrastructure version");
  }

  return semver.lt(normalizedServerVersion, normalizedRequiredVersion);
}

export function resolveVersionEndpoint(serverBaseUrl: string): string {
  const url = new URL(serverBaseUrl.trim());
  const pathname = url.pathname.replace(/\/+$/, "");

  url.hash = "";
  url.search = "";
  url.pathname = `${pathname}/version`;
  return url.toString();
}

const createInfrastructureRemediation = (): InfrastructureRemediation => ({
  fixability: "blocked",
  reason:
    "Server infrastructure changes usually need provider credentials, environment variables, and redeploy access.",
  commands: [...INFRASTRUCTURE_RECOVERY_COMMANDS],
});

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

  return {
    status: {
      detected: true,
      files: [...files, ...appDelegateFiles],
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
  const configuredPaths = config.platform.android.stringResourcePaths;
  const androidDetected =
    fs.existsSync(path.join(cwd, "android")) || configuredPaths.length > 0;

  if (!androidDetected) {
    return { issues: [] };
  }

  const androidParser = new AndroidConfigParser(configuredPaths);
  const files = configuredPaths.filter((filePath) =>
    fs.existsSync(resolveProjectPath(cwd, filePath)),
  );
  const issues: NativeCheckIssue[] = [];

  if (!(await androidParser.exists())) {
    issues.push({
      type: "error",
      platform: "android",
      code: "NATIVE_FILES_NOT_FOUND",
      message: "Android strings.xml files were not found.",
      resolution:
        "Check platform.android.stringResourcePaths in hot-updater.config.ts or run Android prebuild first.",
      fixability: "auto",
      paths: configuredPaths,
    });
  }

  const channel = await androidParser.get("hot_updater_channel");
  const fingerprintHash = requireFingerprint
    ? await androidParser.get("hot_updater_fingerprint_hash")
    : undefined;

  if (requireFingerprint && !fingerprintHash?.value) {
    issues.push({
      type: "error",
      platform: "android",
      code: "MISSING_FINGERPRINT_HASH",
      message: "hot_updater_fingerprint_hash is missing from strings.xml.",
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
      message: "hot_updater_fingerprint_hash does not match fingerprint.json.",
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

  return {
    status: {
      detected: true,
      files: [...files, ...mainApplicationFiles],
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
}: {
  cwd: string;
}): Promise<NativeStatus | undefined> {
  const hasNativeDirectories =
    fs.existsSync(path.join(cwd, "ios")) ||
    fs.existsSync(path.join(cwd, "android"));

  if (!hasNativeDirectories) {
    return undefined;
  }

  const config = await loadConfig(null);
  const localFingerprint = await readLocalFingerprintFile(cwd);
  const requireFingerprint = config.updateStrategy === "fingerprint";

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
    validateSigningConfig(config),
  ]);

  const issues = [
    ...ios.issues,
    ...android.issues,
    ...signing.issues.map(toNativeIssue),
  ];

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

async function checkInfrastructureStatus({
  serverBaseUrl,
  fetchImpl = fetch,
  requiredVersion = getRequiredInfrastructureVersion(),
}: {
  serverBaseUrl: string;
  fetchImpl?: typeof fetch;
  requiredVersion?: string;
}): Promise<InfrastructureStatus> {
  const versionEndpoint = resolveVersionEndpoint(serverBaseUrl);
  const baseUrl = serverBaseUrl.trim();

  try {
    const response = await fetchImpl(versionEndpoint, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return {
          baseUrl,
          versionEndpoint,
          requiredVersion,
          needsUpdate: true,
          updateReason: "Version endpoint not found",
        };
      }

      return {
        baseUrl,
        versionEndpoint,
        requiredVersion,
        error: `Version endpoint returned ${response.status}`,
      };
    }

    const data = (await response.json()) as ServerVersionResponse;
    if (typeof data.version !== "string") {
      return {
        baseUrl,
        versionEndpoint,
        requiredVersion,
        error: "Version endpoint response must include a string version",
      };
    }

    const needsUpdate = isInfrastructureUpdateRequired({
      serverVersion: data.version,
      requiredVersion,
    });

    return {
      baseUrl,
      versionEndpoint,
      serverVersion: data.version,
      requiredVersion,
      needsUpdate,
    };
  } catch (error) {
    return {
      baseUrl,
      versionEndpoint,
      requiredVersion,
      error: (error as Error).message,
    };
  }
}

/**
 * Performs health check on Hot Updater installation
 * @param options - Doctor check options
 * @returns true if everything is healthy, or DoctorResult with details if there are issues
 */
export async function doctor(
  options: DoctorOptions = {},
): Promise<true | DoctorResult> {
  try {
    const { cwd = getCwd(), serverBaseUrl, fetch: fetchImpl } = options;

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
      details.infrastructure = await checkInfrastructureStatus({
        serverBaseUrl,
        fetchImpl,
        requiredVersion: getRequiredInfrastructureVersion(hotUpdaterVersion),
      });

      if (
        details.infrastructure.error !== undefined ||
        details.infrastructure.needsUpdate === true
      ) {
        details.infrastructure.remediation = createInfrastructureRemediation();
      }
    }

    if (hasReactNativePackage) {
      details.native = await checkNativeStatus({ cwd });
    }

    // Add version mismatches if any
    if (versionMismatches.length > 0) {
      details.versionMismatches = versionMismatches;
    }

    // Check if there are any issues
    const hasInfrastructureIssue =
      details.infrastructure?.error !== undefined ||
      details.infrastructure?.needsUpdate === true;
    const hasNativeIssue =
      details.native?.issues.some((issue) => issue.type === "error") === true;
    const hasIssues =
      versionMismatches.length > 0 || hasInfrastructureIssue || hasNativeIssue;
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

    if (details.native) {
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

const promptServerBaseUrl = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const serverBaseUrl = await p.text({
    message: "Server base URL for infrastructure check (Enter to skip)",
    placeholder: "https://example.com/api/check-update",
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

export const handleDoctor = async ({
  serverBaseUrl,
  json = false,
}: HandleDoctorOptions = {}) => {
  if (json) {
    const result = normalizeDoctorResult(await doctor({ serverBaseUrl }));
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exit(1);
    }
    return;
  }

  p.intro("Hot Updater doctor");

  const resolvedServerBaseUrl = serverBaseUrl ?? (await promptServerBaseUrl());
  const result = await doctor({ serverBaseUrl: resolvedServerBaseUrl });

  if (result === true) {
    p.log.success("All checks passed.");
    p.outro("Healthy.");
    return;
  }

  // Handle errors
  if (result.error) {
    p.log.error(result.error);
    p.outro("Doctor check failed.");
    return;
  }

  // Handle issues with details
  const { details } = result;
  let shouldExitWithFailure = !result.success;

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
    p.log.message(ui.block("Infrastructure", lines));

    if (infrastructure.needsUpdate) {
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

    if (infrastructure.remediation) {
      p.log.message(
        ui.block("Recovery", [
          ui.kv("Managed", ui.command("hot-updater init")),
          ui.kv(
            "@hot-updater/server (self-hosted)",
            ui.line([
              ui.command("hot-updater db generate"),
              "or",
              ui.command("hot-updater db migrate"),
              "then redeploy server",
            ]),
          ),
        ]),
      );
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
      p.log.info(issue.resolution);
    }
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

  if (shouldExitWithFailure) {
    process.exit(1);
  }

  p.log.success("All checks passed.");
  p.outro("Doctor complete.");
};
