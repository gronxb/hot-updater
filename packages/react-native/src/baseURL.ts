import type { HotUpdaterBaseURL } from "./types";

/** Resolves a functional baseURL and drops trailing slashes. */
export const resolveBaseURL = async (
  baseURL: HotUpdaterBaseURL,
): Promise<string> => {
  const resolvedBaseURL =
    typeof baseURL === "function" ? await baseURL() : baseURL;

  if (!resolvedBaseURL) {
    throw new Error("baseURL function must return a non-empty string");
  }

  return resolvedBaseURL.replace(/\/+$/, "");
};
