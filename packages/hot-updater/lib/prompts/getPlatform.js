import { select } from "@clack/prompts";
export const getPlatform = async (message) => {
    const platform = await select({
        message: message,
        initialValue: "ios",
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
