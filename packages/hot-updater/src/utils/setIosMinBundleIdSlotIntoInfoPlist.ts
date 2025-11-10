import { IosConfigParser } from "@/utils/configParser/iosParser";

export const setIosMinBundleIdSlotIntoInfoPlist = async ({
  infoPlistPaths,
}: {
  infoPlistPaths?: string[];
}) => {
  const iosParser = new IosConfigParser(infoPlistPaths);
  return await iosParser.set(
    "HOT_UPDATER_MIN_BUNDLE_ID",
    "$(HOT_UPDATER_MIN_BUNDLE_ID)",
  );
};
