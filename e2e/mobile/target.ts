import path from "node:path";

export type MobileRuntime = "react-native" | "lynx";

export function resolveMobileRuntime(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): MobileRuntime {
  if (value !== undefined) {
    if (value !== "react-native" && value !== "lynx")
      throw new Error("--runtime must be react-native or lynx");
    return value;
  }
  const appDir =
    env.HOT_UPDATER_E2E_ENV_TARGET_DIR ??
    (env.HOT_UPDATER_E2E_ENV_TARGET_PATH
      ? path.dirname(env.HOT_UPDATER_E2E_ENV_TARGET_PATH)
      : "");
  return path.basename(appDir) === "lynx" ||
    env.HOT_UPDATER_E2E_APP_ID === "com.hotupdater.lynxexample"
    ? "lynx"
    : "react-native";
}

export function lynxMobileEnvironment(
  repoDir: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const appDir =
    env.HOT_UPDATER_E2E_ENV_TARGET_DIR ??
    (env.HOT_UPDATER_E2E_ENV_TARGET_PATH
      ? path.dirname(env.HOT_UPDATER_E2E_ENV_TARGET_PATH)
      : path.join(repoDir, "examples/lynx"));
  return {
    ...env,
    HOT_UPDATER_E2E_ENV_TARGET_DIR: appDir,
    HOT_UPDATER_E2E_APP_ID:
      env.HOT_UPDATER_E2E_APP_ID ?? "com.hotupdater.lynxexample",
    HOT_UPDATER_E2E_IOS_APP_ID:
      env.HOT_UPDATER_E2E_IOS_APP_ID ??
      env.HOT_UPDATER_E2E_APP_ID ??
      "com.hotupdater.lynxexample",
    HOT_UPDATER_E2E_IOS_BINARY_PATH:
      env.HOT_UPDATER_E2E_IOS_BINARY_PATH ??
      path.join(
        appDir,
        "ios/build/e2e/Build/Products/Release-iphonesimulator/SparklingGoE2E.app",
      ),
    HOT_UPDATER_E2E_ANDROID_BINARY_PATH:
      env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH ??
      env.HOT_UPDATER_E2E_ANDROID_APK_PATH ??
      path.join(
        appDir,
        "android/e2e-app/build/outputs/apk/release/e2e-app-release.apk",
      ),
  };
}
