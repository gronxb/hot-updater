import { BuildFailedError } from "@hot-updater/cli-tools";

export const prettifyXcodebuildError = (error: any) => {
  if (error instanceof BuildFailedError) {
    // The summary holds xcodebuild's error lines, which the log has whole.
    const errorLines = error.summary.join("\n");
    const message =
      errorLines.includes("error: No profiles for") ||
      errorLines.includes("error: Provisioning profile")
        ? "No valid provisioning profile is set in the project.\nCheck the Signing & Capabilities tab in Xcode."
        : error.message;
    // The logger printed xcodebuild's errors and the log's path above.
    return new BuildFailedError(message, {
      logPath: error.logPath,
      summary: error.summary,
      cause: error.cause,
    });
  }

  return new Error(`Xcodebuild failed: ${error}`);
};
