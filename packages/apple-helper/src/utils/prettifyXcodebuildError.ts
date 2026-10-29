import { BuildFailedError } from "@hot-updater/cli-tools";

import {
  mentionsProgramLicenseAgreement,
  PROGRAM_LICENSE_AGREEMENT_HINT,
} from "../asc/programLicenseAgreement";

export const prettifyXcodebuildError = (error: any) => {
  if (error instanceof BuildFailedError) {
    // The summary holds xcodebuild's error lines, which the log has whole.
    const errorLines = error.summary.join("\n");
    const hint = mentionsProgramLicenseAgreement(errorLines)
      ? PROGRAM_LICENSE_AGREEMENT_HINT
      : errorLines.includes("error: No profiles for") ||
          errorLines.includes("error: Provisioning profile")
        ? "No valid provisioning profile is set in the project.\nCheck the Signing & Capabilities tab in Xcode."
        : null;
    // The logger printed xcodebuild's errors and the log's path above.
    return new BuildFailedError(hint ?? error.message, {
      logPath: error.logPath,
      summary: error.summary,
      hint,
      cause: error.cause,
    });
  }

  return new Error(`Xcodebuild failed: ${error}`);
};
