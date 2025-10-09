import * as p from "@clack/prompts";
import { getCwd } from "@hot-updater/plugin-core";
import { execa } from "execa";
import fs from "fs";
import path from "path";

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

  try {
    if (shouldUseBundler) {
      p.log.info("Using bundler for CocoaPods installation");

      const bundleSpinner = p.spinner();
      bundleSpinner.start("Installing Ruby gems");
      await execa("bundle", ["install"], { cwd: sourceDir });
      bundleSpinner.stop("Ruby gems installed");

      const podSpinner = p.spinner();
      podSpinner.start("Installing CocoaPods dependencies");
      await execa("bundle", ["exec", "pod", "install"], { cwd: sourceDir });
      podSpinner.stop("CocoaPods dependencies installed");
    } else {
      const spinner = p.spinner();
      spinner.start("Installing CocoaPods dependencies");
      await execa("pod", ["install"], { cwd: sourceDir });
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
  } catch (_error) {
    return false;
  }
};
