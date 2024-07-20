import { select } from "@clack/prompts";

export const getPlatform = async () => {
  const platform = await select({
    message: "Which platform do you want to deploy?",
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
