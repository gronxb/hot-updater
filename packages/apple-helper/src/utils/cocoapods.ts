import fs from "fs";
import path from "path";

import { getCwd, getReactNativeMetadatas, p } from "@hot-updater/cli-tools";
import { execa } from "execa";

export const installPodsIfNeeded = async (sourceDir: string): Promise<void> => {
  const podfilePath = path.join(sourceDir, "Podfile");

  // Check if Podfile exists
  const fileExist = fs.existsSync(podfilePath);

  if (!fileExist) {
    p.log.info("No Podfile found, skipping CocoaPods installation");
    return;
  }

  const gemfilePaths = [
    path.join(sourceDir, "Gemfile"),
    path.join(getCwd(), "Gemfile"),
  ];
  const shouldUseBundler = (
    await Promise.all(gemfilePaths.map(checkShouldUseBundler))
  ).some(Boolean);

  const reactNative = getReactNativeMetadatas();
  const plan = resolvePodInstallPlan({
    version: reactNative.version,
    env: process.env,
  });

  if (plan.runCodegen) {
    await runReactNativeCodegen({
      projectRoot: getCwd(),
      reactNativePath: reactNative.packagePath,
      sourceDir,
    });
  }

  try {
    if (shouldUseBundler) {
      p.log.info("Using bundler for CocoaPods installation");

      const bundleSpinner = p.spinner();
      bundleSpinner.start("Installing Ruby gems");
      await execa("bundle", ["install"], { cwd: sourceDir });
      bundleSpinner.stop("Ruby gems installed");

      const podSpinner = p.spinner();
      podSpinner.start("Installing CocoaPods dependencies");
      await execa("bundle", ["exec", "pod", "install"], {
        cwd: sourceDir,
        env: plan.env,
      });
      podSpinner.stop("CocoaPods dependencies installed");
    } else {
      const spinner = p.spinner();
      spinner.start("Installing CocoaPods dependencies");
      await execa("pod", ["install"], {
        cwd: sourceDir,
        env: plan.env,
      });
      spinner.stop("CocoaPods dependencies installed");
    }
  } catch (error) {
    throw new Error(`pod install failed: ${error}`);
  }
};

const checkShouldUseBundler = async (gemfilePath: string): Promise<boolean> => {
  try {
    if (!fs.existsSync(gemfilePath)) {
      return false;
    }

    const gemfileContent = await fs.promises.readFile(gemfilePath, "utf-8");
    return gemfileContent.includes("cocoapods");
  } catch {
    return false;
  }
};

/**
 * Runs React Native codegen into `<sourceDir>/build/generated/ios`, as the
 * React Native CLI does before `pod install`. Clearing the old output first
 * drops the modules of removed libraries.
 */
const runReactNativeCodegen = async ({
  projectRoot,
  reactNativePath,
  sourceDir,
}: {
  projectRoot: string;
  reactNativePath: string;
  sourceDir: string;
}): Promise<void> => {
  await fs.promises.rm(path.join(sourceDir, "build", "generated", "ios"), {
    recursive: true,
    force: true,
  });

  const spinner = p.spinner();
  spinner.start("Running React Native codegen");
  try {
    await execa(
      "node",
      [
        path.join(reactNativePath, "scripts", "generate-codegen-artifacts.js"),
        "-p",
        projectRoot,
        "-o",
        sourceDir,
        "-t",
        "ios",
      ],
      { cwd: projectRoot },
    );
  } catch (error) {
    spinner.stop("React Native codegen failed");
    throw new Error(`React Native codegen failed: ${error}`);
  }
  spinner.stop("React Native codegen done");
};

/**
 * The environment `pod install` runs with, and whether codegen runs first.
 *
 * From React Native 0.79, `RCT_IGNORE_PODS_DEPRECATION=1` silences the
 * deprecation notice for calling `pod install` directly and also sets
 * `RCT_SKIP_CODEGEN=1`, because the React Native CLI runs codegen itself
 * first. Hot Updater sets it the same way and runs codegen too, unless the
 * user's `RCT_SKIP_CODEGEN=1` takes codegen over. Before 0.79, and when the
 * version is unknown, CocoaPods runs codegen. A user's value of a flag wins.
 */
export const resolvePodInstallPlan = ({
  version,
  env,
}: {
  version: { major: number; minor: number };
  env: NodeJS.ProcessEnv;
}): { env: Record<string, string>; runCodegen: boolean } => {
  const podsSkipCodegen = version.major > 0 || version.minor >= 79;
  const usePrebuiltReactNative = version.major > 0 || version.minor >= 81;
  const ignorePodsDeprecation =
    env["RCT_IGNORE_PODS_DEPRECATION"] ?? (podsSkipCodegen ? "1" : undefined);

  return {
    runCodegen:
      podsSkipCodegen &&
      ignorePodsDeprecation === "1" &&
      env["RCT_SKIP_CODEGEN"] !== "1",
    env: {
      ...(ignorePodsDeprecation !== undefined && {
        RCT_IGNORE_PODS_DEPRECATION: ignorePodsDeprecation,
      }),
      RCT_USE_RN_DEP:
        env["RCT_USE_RN_DEP"] ?? (usePrebuiltReactNative ? "1" : "0"),
      RCT_USE_PREBUILT_RNCORE:
        env["RCT_USE_PREBUILT_RNCORE"] ?? (usePrebuiltReactNative ? "1" : "0"),
    },
  };
};
