import { colors, getCwd, getPackageManager, p } from "@hot-updater/cli-tools";
import fs from "fs";
import path from "path";

/**
 * Checks if a package can be resolved using require.resolve.
 * Exported for testing purposes.
 * @param packagePath - The package path to resolve
 * @returns true if the package can be resolved
 */
function hasPackage(packagePath: string): boolean {
  try {
    require.resolve(`${packagePath}/package.json`, {
      paths: [getCwd()],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if expo-updates is installed in the project.
 * Uses require.resolve() as the primary check with file reading as fallback.
 * @returns true if expo-updates is found in dependencies or devDependencies
 */
export function hasExpoUpdates(): boolean {
  // Primary check: Use require.resolve to check if package is installed
  if (hasPackage("expo-updates")) {
    return true; // Package is installed and resolvable
  }

  // Fallback check: Read package.json from file system
  const cwd = getCwd();
  const packageJsonPath = path.join(cwd, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJsonContent = fs.readFileSync(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);

    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};

    return !!dependencies["expo-updates"] || !!devDependencies["expo-updates"];
  } catch (_e) {
    return false;
  }
}

/**
 * Checks for critical conflicts and exits the process if any are found.
 * Currently checks for:
 * - expo-updates (incompatible with hot-updater)
 */
export function ensureNoConflicts(): void {
  if (hasExpoUpdates()) {
    p.log.error(
      colors.bgRed(
        colors.white(colors.bold(" ⚠️  CRITICAL CONFLICT DETECTED ⚠️  ")),
      ),
    );
    p.log.warn(
      colors.yellow("You have 'expo-updates' installed in your project."),
    );
    p.log.warn(
      colors.yellow(
        "Hot Updater is completely incompatible with expo-updates.",
      ),
    );
    p.log.warn(
      colors.yellow(
        "Both libraries attempt to control the update process, which will cause your app to crash or behave unpredictably.",
      ),
    );

    console.log();
    p.log.error(
      colors.red(colors.bold("YOU MUST REMOVE expo-updates TO PROCEED.")),
    );
    console.log();

    const pm = getPackageManager();
    const removeCmd =
      pm === "npm" ? "uninstall" : pm === "yarn" ? "remove" : "remove";

    p.log.info("Please run the following command to remove it:");
    p.log.info(colors.cyan(`  ${pm} ${removeCmd} expo-updates`));

    process.exit(1);
  }
}
