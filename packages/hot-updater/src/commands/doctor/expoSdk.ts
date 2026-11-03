import {
  type ConfigResponse,
  EXPO_SDK_UPGRADE_COMMAND,
  MINIMUM_EXPO_SDK,
  readExpoSdk,
} from "@hot-updater/cli-tools";

import type { NativeCheckIssue } from "./issues";

/** An Expo project below the SDK Hot Updater supports. */
export const checkExpoSdk = async (
  config: ConfigResponse,
  cwd: string,
): Promise<NativeCheckIssue[]> => {
  const adapter = await Promise.resolve(config.build({ cwd }))
    .then(({ name }) => name)
    .catch(() => undefined);
  if (adapter !== "expo") return [];
  const expo = readExpoSdk(cwd);
  if (expo === null || expo.sdk >= MINIMUM_EXPO_SDK) return [];
  return [
    {
      type: "error",
      platform: "project",
      code: "EXPO_SDK_UNSUPPORTED",
      message: `Hot Updater requires Expo SDK ${MINIMUM_EXPO_SDK} or later. This project uses SDK ${expo.sdk}.`,
      resolution: `Run \`${EXPO_SDK_UPGRADE_COMMAND}\`.`,
      commands: [EXPO_SDK_UPGRADE_COMMAND],
    },
  ];
};
