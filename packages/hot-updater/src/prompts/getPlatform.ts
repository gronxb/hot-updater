import { select } from "@clack/prompts";
import type { Platform } from "@hot-updater/utils";

export const getPlatform = async (message: string) => {
  const platform = await select({
    message: message,
    initialValue: "ios" as Platform,
    options: [
      { label: "ios", value: "ios" },
      { label: "android", value: "android" },
    ],
  });

  if (typeof platform !== "string") {
    throw new Error("Invalid platform");
  }

  return platform;
};
