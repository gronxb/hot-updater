export function getAndroidSdkPath() {
  const sdkRoot =
    process.env["ANDROID_HOME"] || process.env["ANDROID_SDK_ROOT"];
  if (!sdkRoot) {
    throw new Error(
      "ANDROID_HOME or ANDROID_SDK_ROOT environment variable is not set. See https://developer.android.com/studio/command-line/variables",
    );
  }
  return sdkRoot;
}
