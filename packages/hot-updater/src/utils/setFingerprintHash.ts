import { AndroidConfigParser } from "./configParser/androidParser";
import { IosConfigParser } from "./configParser/iosParser";

const setAndroidFingerprintHash = async (
  hash: string,
): Promise<{ path: string | null }> => {
  const androidParser = new AndroidConfigParser();
  return await androidParser.set("hot_updater_fingerprint_hash", hash);
};

const getAndroidFingerprintHash = async (): Promise<{
  value: string | null;
  path: string;
}> => {
  const androidParser = new AndroidConfigParser();
  if (!androidParser.exists()) {
    throw new Error("android/app/src/main/res/values/strings.xml not found");
  }
  return androidParser.get("hot_updater_fingerprint_hash");
};

const setIosFingerprintHash = async (
  hash: string,
): Promise<{ path: string | null }> => {
  const iosParser = new IosConfigParser();
  return await iosParser.set("HOT_UPDATER_FINGERPRINT_HASH", hash);
};

const getIosFingerprintHash = async (): Promise<{
  value: string | null;
  path: string | null;
}> => {
  const iosParser = new IosConfigParser();
  if (!iosParser.exists()) {
    throw new Error("Info.plist not found");
  }
  return iosParser.get("HOT_UPDATER_FINGERPRINT_HASH");
};

export const setFingerprintHash = async (
  platform: "android" | "ios",
  hash: string,
): Promise<{ path: string | null }> => {
  switch (platform) {
    case "android":
      return await setAndroidFingerprintHash(hash);
    case "ios":
      return await setIosFingerprintHash(hash);
  }
};
export const getFingerprintHash = async (
  platform: "android" | "ios",
): Promise<{
  value: string | null;
  path: string | null;
}> => {
  switch (platform) {
    case "android":
      return await getAndroidFingerprintHash();
    case "ios":
      return await getIosFingerprintHash();
  }
};
