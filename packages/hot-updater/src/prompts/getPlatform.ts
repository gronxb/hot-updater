import * as p from "@clack/prompts";
import type { Platform } from "@hot-updater/core";

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
