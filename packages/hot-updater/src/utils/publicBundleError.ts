import { fitText, p } from "@hot-updater/cli-tools";
import {
  type HotUpdaterCoreApi,
  ReleaseCatalogMutationError,
  ReleaseManagementError,
} from "@hot-updater/plugin-core";

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

const RELEASE_NOT_FOUND = "RELEASE_NOT_FOUND";

/**
 * Ends a bundle command core refused, such as for an ID no bundle has, with
 * the reason and no stack: on stdout as JSON under `--json`, with the
 * message on stderr. An artifact ID, which `native-build mark` and
 * `patch -b` print, names no bundle, so a missing ID costs one indexed read
 * for the newest bundle that ships it, only on this path. Anything but a
 * refusal is thrown on.
 */
export const failBundleCommand = async (
  core: HotUpdaterCoreApi,
  releaseId: string,
  error: unknown,
  { json, outcome }: { readonly json?: boolean; readonly outcome: string },
): Promise<void> => {
  if (
    !(error instanceof ReleaseManagementError) &&
    !(error instanceof ReleaseCatalogMutationError)
  ) {
    throw error;
  }
  const notFound = error.code === RELEASE_NOT_FOUND;
  const [shipping = null] = notFound
    ? await core
        .listReleases({
          filter: { kind: "bundle", bundleId: releaseId },
          limit: 1,
          order: "desc",
        })
        .catch(() => [])
    : [];
  const message = notFound
    ? [
        `No bundle with ID ${releaseId}.`,
        shipping !== null && `That's an artifact ID. Use bundle ${shipping.id}`,
      ]
        .filter(Boolean)
        .join("\n")
    : publicBundleMessage(error.message);
  if (json) {
    console.log(
      JSON.stringify({
        id: releaseId,
        [outcome]: false,
        reason: notFound ? "not_found" : error.code.toLowerCase(),
        ...(shipping === null ? {} : { releaseId: shipping.id }),
      }),
    );
    console.error(fitText(message));
  } else {
    p.log.error(message);
  }
  process.exitCode = 1;
};

export const notFoundError = (releaseId: string) =>
  new ReleaseManagementError(
    RELEASE_NOT_FOUND,
    `Release "${releaseId}" was not found.`,
  );
