import { BuildLogger } from "@hot-updater/cli-tools";

export const createXcodebuildLogger = ({ logPrefix }: { logPrefix: string }) =>
  new BuildLogger({
    logPrefix,
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
