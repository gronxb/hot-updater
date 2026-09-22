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
import { merge } from "es-toolkit";
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
import {
  type SigningConfigIssue,
  validateSigningConfig,
} from "../utils/signing/validateSigningConfig";
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
  isV1InfrastructureRequired,
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

type DoctorFixability = "auto" | "command" | "blocked";
type NativePlatform = "ios" | "android";
type NativeIssueType = "error" | "warning";

interface NativeCheckIssue {
  type: NativeIssueType;
  platform: NativePlatform | "project";
  code: string;
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
  verification?: DoctorVerification;
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

const resolveProjectPath = (cwd: string, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

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
        "Run `npx hot-updater fingerprint create` or rebuild through the selected integration.",
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

  return {
    status: {
      detected: true,
      files,
      channel: channel.value ?? undefined,
      fingerprintHash: fingerprintHash?.value ?? undefined,
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

  const channel = await androidParser.get("hot_updater_channel");
  const fingerprintHash = requireFingerprint
    ? await androidParser.get("hot_updater_fingerprint_hash")
    : undefined;

  if (requireFingerprint && !fingerprintHash?.value) {
    issues.push({
      type: "error",
      platform: "android",
      code: "MISSING_FINGERPRINT_HASH",
      message:
        "com.hotupdater.FINGERPRINT_HASH is missing from AndroidManifest.xml.",
      resolution:
        "Run `npx hot-updater fingerprint create` or rebuild through the selected integration.",
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

  return {
    status: {
      detected: true,
      files,
      channel: channel.value ?? undefined,
      fingerprintHash: fingerprintHash?.value ?? undefined,
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
  const config = await loadConfig(null);
  const buildPlugin = await config.build({ cwd });
  await buildPlugin.integration?.beforeCommand?.({ command: "doctor" });
  const integration = await buildPlugin.integration?.doctor?.();
  const getNativeSigningPublicKey =
    buildPlugin.nativeBuild?.getBundleSigningPublicKey;
  const nativeSigningPublicKey = getNativeSigningPublicKey
    ? await getNativeSigningPublicKey()
    : undefined;
  const expectedSigningPublicKey =
    (await getBundleSigningPublicKey(config.signing, { cwd }).catch(
      () => "invalid configured bundle signing public key",
    )) ?? undefined;
  const signingOptions = {
    expectedPublicKey: expectedSigningPublicKey,
    ...(buildPlugin.nativeBuild?.signingConfigSource === undefined
      ? {}
      : { signingConfigSource: buildPlugin.nativeBuild.signingConfigSource }),
    ...(getNativeSigningPublicKey === undefined
      ? {}
      : { nativePublicKey: nativeSigningPublicKey?.publicKey ?? null }),
  };
  const hasNativeDirectories =
    fs.existsSync(path.join(cwd, "ios")) ||
    fs.existsSync(path.join(cwd, "android"));

  if (!hasNativeDirectories) {
    if (!getNativeSigningPublicKey && !integration) return undefined;
    const signing = await validateSigningConfig(config, signingOptions);
    return {
      updateStrategy: config.updateStrategy,
      issues: [
        ...(integration?.issues ?? []),
        ...signing.issues.map(toNativeIssue),
      ],
    };
  }

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
    validateSigningConfig(config, signingOptions),
  ]);

  const issues: NativeCheckIssue[] = [
    ...ios.issues,
    ...android.issues,
    ...(integration?.issues ?? []),
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

  const mergeIntegrationStatus = (
    status: NativePlatformStatus | undefined,
    platform: "ios" | "android",
  ): NativePlatformStatus | undefined => {
    const integrationStatus = integration?.platforms?.[platform];
    if (!status && !integrationStatus) return undefined;
    return {
      detected: status?.detected ?? true,
      files: [...(status?.files ?? []), ...(integrationStatus?.files ?? [])],
      channel: status?.channel,
      fingerprintHash: status?.fingerprintHash,
      bundleProviderConfigured: integrationStatus?.configured,
    };
  };

  return {
    updateStrategy: config.updateStrategy,
    fingerprintJsonPath: localFingerprint?.path,
    ios: mergeIntegrationStatus(ios.status, "ios"),
    android: mergeIntegrationStatus(android.status, "android"),
    issues,
  };
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

    details.native = await checkNativeStatus({ cwd });

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

export const handleDoctor = async ({
  serverBaseUrl,
  json = false,
  ...verificationOptions
}: HandleDoctorOptions = {}) => {
  if (json) {
    const result = normalizeDoctorResult(
      await doctor({ serverBaseUrl, ...verificationOptions }),
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
