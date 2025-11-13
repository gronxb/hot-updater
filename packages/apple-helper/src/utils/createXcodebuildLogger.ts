import { BuildLogger } from "@hot-updater/cli-tools";

export const createXcodebuildLogger = () =>
  new BuildLogger({
    failurePatterns: ["BUILD FAILED", "ARCHIVE FAILED"],
    importantLogPatterns: [
      "error:",
      "** BUILD FAILED **",
      "** ARCHIVE FAILED **",
      "The following build commands failed:",
    ],
    progressMapping: [
      [["[CP-User] [RN]Check rncore"], 10],
      [["[CP-User] [Hermes] Replace Hermes"], 35],
      [["[CP-User] [RN]Check FBReactNativeSpec"], 53],
      [["React-FabricComponents"], 66],
      [["[CP] Check Pods Manifest.lock"], 90],
      [["BUILD SUCCEEDED", "ARCHIVE SUCCEEDED"], 100],
    ],
  });
