import { BuildLogger } from "@hot-updater/cli-tools";

export const createXcodebuildLogger = ({ logPrefix }: { logPrefix: string }) =>
  new BuildLogger({
    logPrefix,
    importantLogPatterns: [
      // Keep errors and explicit failure points visible.
      "error:",
      "** BUILD FAILED **",
      "** ARCHIVE FAILED **",
      "The following build commands failed:",
      // Keep small set of high-signal build lifecycle markers.
      "note: Building targets in dependency order",
      "note: Target dependency graph",
      "Running script",
      "[CP-User]",
      "[CP] Check Pods Manifest.lock",
      "Build Succeeded",
    ],
    progressStages: [
      ["Building targets in dependency order", "Target dependency graph"],
      ["Write Auxiliary File", "[CP] Check Pods Manifest.lock"],
      [
        "Running script",
        "[CP-User] [RN]Check rncore",
        "[CP-User] [Hermes] Replace Hermes",
        "[CP-User] [RN]Check FBReactNativeSpec",
      ],
      ["Processing", "ProcessProductPackaging", "ProcessProductPackagingDER"],
      ["Compiling"],
      ["RegisterExecutionPolicyException"],
      ["Touching"],
      ["Building library", "Create Universal Binary"],
      ["Copying"],
      ["Build Succeeded", "BUILD SUCCEEDED", "ARCHIVE SUCCEEDED"],
    ],
  });
