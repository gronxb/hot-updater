import { loadConfig } from "@hot-updater/plugin-core";
import { AndroidConfigParser } from "./configParser/androidParser";
import { IosConfigParser } from "./configParser/iosParser";

const setAndroidFingerprintHash = async (
  hash: string,
): Promise<{ path: string | null }> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.android?.stringResourcePaths;
  const androidParser = new AndroidConfigParser(customPaths);
  return await androidParser.set("hot_updater_fingerprint_hash", hash);
};

const getAndroidFingerprintHash = async (): Promise<{
  value: string | null;
  path: string;
}> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.android?.stringResourcePaths;
  const androidParser = new AndroidConfigParser(customPaths);
  if (!(await androidParser.exists())) {
    throw new Error("No Android strings.xml files found");
  }
  return androidParser.get("hot_updater_fingerprint_hash");
};

const setIosFingerprintHash = async (
  hash: string,
): Promise<{ path: string | null }> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.ios?.infoPlistPaths;
  const iosParser = new IosConfigParser(customPaths);
  return await iosParser.set("HOT_UPDATER_FINGERPRINT_HASH", hash);
};

const getIosFingerprintHash = async (): Promise<{
  value: string | null;
  path: string | null;
}> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.ios?.infoPlistPaths;
  const iosParser = new IosConfigParser(customPaths);
  if (!(await iosParser.exists())) {
    throw new Error("No iOS Info.plist files found");
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
