import { p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/protocol";

export const getPlatform = async (message: string) => {
  return await p.select({
    message: message,
    initialValue: "ios" as Platform,
    options: [
      { label: "ios", value: "ios" },
      { label: "android", value: "android" },
    ],
  });
};
