import { ReleaseManagementError } from "@hot-updater/plugin-core";

/** Core's message about a release, in the CLI's words: a bundle. */
export const publicBundleMessage = (message: string): string =>
  message
    .replace(/\bRelease\b/g, "Bundle")
    .replace("Bundle Bundle", "deployed Bundle");

export const withPublicBundleErrors = async <T>(
  action: () => Promise<T>,
): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReleaseManagementError) {
      throw new Error(publicBundleMessage(error.message), { cause: error });
    }
    throw error;
  }
};
