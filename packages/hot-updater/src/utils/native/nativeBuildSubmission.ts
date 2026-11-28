import { loadConfig } from "@hot-updater/cli-tools";
import type {
  NativeBuildRow,
  NativeBuildSubmissionDestination,
} from "@hot-updater/plugin-core";

import { loadServer } from "../loadServer";

/**
 * The store's label of a build: its version and build number, as TestFlight
 * and Google Play list it, such as `1.7.0 (66)`, or the build number alone
 * when the version can't be read.
 */
export const storeVersionLabel = (
  version: string | null | undefined,
  buildNumber: string | number,
): string => (version ? `${version} (${buildNumber})` : String(buildNumber));

/**
 * Records on a tracked build that a store took it, after the store accepted
 * the upload or already had the build: the Console shows it. Returns the
 * build's row with the record.
 */
export const recordNativeBuildSubmission = async (
  build: NativeBuildRow,
  destination: NativeBuildSubmissionDestination,
  version: string,
): Promise<NativeBuildRow> => {
  const server = await loadServer(await loadConfig(null));
  try {
    const recorded = await server.core.recordNativeBuildSubmission(build.id, {
      destination,
      version,
    });
    if (recorded === null) {
      throw new Error(`native build ${build.id} is no longer tracked`);
    }
    return recorded;
  } finally {
    await server.dispose();
  }
};
