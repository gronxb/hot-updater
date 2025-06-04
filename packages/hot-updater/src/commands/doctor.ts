import fs from "fs";
import * as p from "@clack/prompts";

import { getCwd } from "@hot-updater/plugin-core";
import { merge } from "es-toolkit";
import { readPackageUp } from "read-package-up";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface VersionMismatch {
  packageName: string;
  currentVersion: string;
  expectedVersion: string;
}

interface DoctorDetails {
  // Version related
  hotUpdaterVersion?: string;
  versionMismatches?: VersionMismatch[];

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

/**
 * Performs health check on Hot Updater installation
 * @param cwd - Current working directory (optional)
 * @returns true if everything is healthy, or DoctorResult with details if there are issues
 */
export async function doctor(
  cwd: string = getCwd(),
): Promise<true | DoctorResult> {
  try {
    // Read package.json
    const packageResult = await readPackageUp({ cwd });

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
      if (currentVersion && currentVersion !== hotUpdaterVersion) {
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

    // Add version mismatches if any
    if (versionMismatches.length > 0) {
      details.versionMismatches = versionMismatches;
    }

    // Check if there are any issues
    const hasIssues = versionMismatches.length > 0;
    // Future: || configurationIssues.length > 0 || etc.

    if (hasIssues) {
      return {
        success: false,
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

/**
 * Fix version mismatches in package.json
 * This is a separate utility function for CLI usage
 */
export async function fixVersionMismatches(
  packageJsonPath: string,
  versionMismatches: VersionMismatch[],
): Promise<void> {
  const packageResult = await fs.promises.readFile(packageJsonPath, "utf-8");
  if (!packageResult) {
    throw new Error("Could not read package.json");
  }

  const packageJson = JSON.parse(packageResult) as PackageJson;

  for (const mismatch of versionMismatches) {
    if (packageJson.dependencies?.[mismatch.packageName]) {
      packageJson.dependencies[mismatch.packageName] = mismatch.expectedVersion;
    } else if (packageJson.devDependencies?.[mismatch.packageName]) {
      packageJson.devDependencies[mismatch.packageName] =
        mismatch.expectedVersion;
    }
  }

  const content = `${JSON.stringify(packageJson, null, 2)}\n`;
  await fs.promises.writeFile(packageJsonPath, content);
}

export const handleDoctor = async ({ fix }: { fix: boolean }) => {
  p.intro("Checking the health of Hot Updater.");

  const result = await doctor();

  if (result === true) {
    p.log.success("✅ All Hot Updater checks passed!");
    p.outro("Hot Updater is healthy.");
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

  if (details?.hotUpdaterVersion) {
    p.log.info(`hot-updater CLI version: ${details.hotUpdaterVersion}`);
  }

  if (details?.versionMismatches && details.versionMismatches.length > 0) {
    p.log.warn("Version mismatches found:");

    for (const mismatch of details.versionMismatches) {
      p.log.error(
        `❌ ${mismatch.packageName}: ${mismatch.currentVersion} ` +
          `(expected ${mismatch.expectedVersion})`,
      );
    }

    if (fix && details.packageJsonPath) {
      try {
        await fixVersionMismatches(
          details.packageJsonPath,
          details.versionMismatches,
        );
        p.log.success("✅ Fixed version mismatches in package.json");
        p.log.info("Run your package manager to install the updated versions.");
      } catch (error) {
        p.log.error(`Failed to fix versions: ${(error as Error).message}`);
      }
    } else if (!fix) {
      p.log.info("Run with --fix to automatically update versions.");
    }
  }

  // Future: Handle other issues in details
  // if (details?.configurationIssues) { ... }

  p.outro("Doctor check complete.");
};
