import { fitText, p } from "@hot-updater/cli-tools";
import {
  type HotUpdaterCoreApi,
  ReleaseCatalogMutationError,
  ReleaseManagementError,
} from "@hot-updater/plugin-core";

import { ui } from "./cli-ui";

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
 * A refusal core words for every client, in the CLI's words: what's wrong,
 * naming the bundle by its first 8 characters, and the command to run next
 * on a line of its own, whole for copying.
 */
const refusalMessage = (
  error: ReleaseManagementError | ReleaseCatalogMutationError,
  releaseId: string,
): string => {
  const shortId = releaseId.slice(0, 8);
  switch (error.code) {
    case "ENABLED_RELEASE":
      return ui.withCommand(
        `Bundle ${shortId} is enabled. Disable it first:`,
        `npx hot-updater bundle disable ${releaseId}`,
      );
    case "VERSION_CONFLICT":
      return [
        publicBundleMessage(error.message).replace(`"${releaseId}"`, shortId),
        ui.withCommand(
          "See what changed:",
          `npx hot-updater bundle show ${releaseId}`,
        ),
      ].join("\n");
    default:
      return publicBundleMessage(error.message);
  }
};

/**
 * Ends a bundle command core refused, such as for an ID no bundle has, with
 * the reason and no stack: on stdout as JSON under `--json`, with the
 * message on stderr. `id` is what the user passed as a bundle ID, a
 * release's. An artifact ID, which `patch -b` takes, names no bundle, so a
 * missing ID costs one indexed read for the newest bundle that ships it as
 * an artifact, only on this path. Anything but a refusal is thrown on.
 */
export const failBundleCommand = async (
  core: HotUpdaterCoreApi,
  id: string,
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
          filter: { kind: "bundle", bundleId: id },
          limit: 1,
          order: "desc",
        })
        .catch(() => [])
    : [];
  const message = notFound
    ? [
        `No bundle with ID ${id}.`,
        shipping !== null && `That's an artifact ID. Use bundle ${shipping.id}`,
      ]
        .filter(Boolean)
        .join("\n")
    : refusalMessage(error, id);
  if (json) {
    console.log(
      JSON.stringify({
        id,
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
