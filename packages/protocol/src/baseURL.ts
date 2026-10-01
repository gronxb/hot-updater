/** The server's base URL, or a function that returns it, as the SDK takes it. */
export type HotUpdaterBaseURL = string | (() => string | Promise<string>);

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
