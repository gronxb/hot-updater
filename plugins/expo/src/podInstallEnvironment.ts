import { getReactNativeMetadatas } from "./reactNativeMetadata";

export function getReactNativePodInstallEnvironment(
  cwd: string,
): Record<string, string> {
  const { minor } = getReactNativeMetadatas(cwd).version;
  const prebuilt = minor >= 81 ? "1" : "0";
  return {
    RCT_IGNORE_PODS_DEPRECATION: "1",
    RCT_USE_RN_DEP: process.env["RCT_USE_RN_DEP"] ?? prebuilt,
    RCT_USE_PREBUILT_RNCORE: process.env["RCT_USE_PREBUILT_RNCORE"] ?? prebuilt,
  };
}
