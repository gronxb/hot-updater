import { select } from "@clack/prompts";

export const getPlatform = async (message: string) => {
  const platform = await select({
    message: message,
    initialValue: "ios" as "ios" | "android",
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
