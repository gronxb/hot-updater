import { ExecaError } from "execa";

export const prettifyXcodebuildError = (error: any) => {
  let errorString = "";
  if (
    error instanceof ExecaError ||
    error instanceof Error ||
    "message" in error
  ) {
    errorString = error.message;
  }

  if (
    errorString.includes("error: No profiles for") ||
    errorString.includes("error: Provisioning profile")
  ) {
    return new Error(
      "Xcodebuild failed: Not valid provisioning profile is set in the project. Check out Singing & Capabilities tab in the Xcode.",
    );
  }

  return new Error(`Xcodebuild failed: ${error}`);
};
