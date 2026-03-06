import { getReactNativeMetadatas, p } from "@hot-updater/cli-tools";
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

  try {
    p.log.info("Installing CocoaPods started");
    await execa("npx", ["-y", "pod-install", "--non-interactive"], {
      cwd: sourceDir,
      env: preparePodInstallEnvVars(),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      timeout: 5 * 60 * 1000, // 5 min timeout,
    });
    p.log.success("CocoaPods dependencies installed");
  } catch (_) {
    // Don't print error because it is printed by `pod-install` itself.
    p.log.error(`pod-install failed`);
    process.exit(1);
  }
};

const preparePodInstallEnvVars = (): Record<string, string> => {
  const { minor } = getReactNativeMetadatas().version;
  const usePrebuiltReactNative = minor >= 81;

  return {
    RCT_IGNORE_PODS_DEPRECATION: "1",
    RCT_USE_RN_DEP:
      process.env["RCT_USE_RN_DEP"] !== undefined
        ? String(process.env["RCT_USE_RN_DEP"])
        : usePrebuiltReactNative
          ? "1"
          : "0",
    RCT_USE_PREBUILT_RNCORE:
      process.env["RCT_USE_PREBUILT_RNCORE"] !== undefined
        ? String(process.env["RCT_USE_PREBUILT_RNCORE"])
        : usePrebuiltReactNative
          ? "1"
          : "0",
  };
};
