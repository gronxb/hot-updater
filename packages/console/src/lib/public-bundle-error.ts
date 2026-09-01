import { ReleaseManagementError } from "@hot-updater/plugin-core";

export const withPublicBundleMutationErrors = async <T>(
  action: () => Promise<T>,
): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReleaseManagementError) {
      throw new Error(
        error.message
          .replace(/\bRelease\b/g, "Bundle")
          .replace("Bundle Bundle", "deployed Bundle"),
        { cause: error },
      );
    }
    throw error;
  }
};
