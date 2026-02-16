import { BuildLogger } from "@hot-updater/cli-tools";

export const createXcodebuildLogger = ({ logPrefix }: { logPrefix: string }) =>
  new BuildLogger({
    logPrefix,
    failurePatterns: ["BUILD FAILED", "ARCHIVE FAILED"],
    progressMapping: [
      [["Building targets in dependency order", "Target dependency graph"], 8],
      [["Write Auxiliary File", "[CP] Check Pods Manifest.lock"], 18],
      [
        [
          "[CP-User] [RN]Check rncore",
          "[CP-User] [Hermes] Replace Hermes",
          "[CP-User] [RN]Check FBReactNativeSpec",
        ],
        30,
      ],
      [["Compiling", "CompileC", "CompileSwift", "SwiftCompile"], 55],
      [["Building library", "Create Universal Binary", "Ld ", "Linking"], 72],
      [["Copying", "ProcessInfoPlistFile", "CodeSign"], 88],
      [["Touching", "RegisterExecutionPolicyException"], 95],
      [["BUILD SUCCEEDED", "ARCHIVE SUCCEEDED"], 100],
    ],
  });
