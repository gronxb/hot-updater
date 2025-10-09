import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";

/**
 * Builds an iOS app without archiving
 */
export const buildXcodeProject = async (
  _sourceDir: string,
  { scheme: { installPods } }: { scheme: NativeBuildIosScheme },
): Promise<void> => {
  // const xcodeProject = await discoverXcodeProject(sourceDir);
  // // Install CocoaPods if requested
  // if (installPods) {
  //   await installPodsIfNeeded(sourceDir);
  // }
  // const buildArgs = prepareBuildArgs(xcodeProject);
  // const logger = new XcodebuildLogger();
  // logger.start(xcodeProject.name);
  // try {
  //   const { stdout, stderr } = await execa("xcodebuild", buildArgs, {
  //     cwd: sourceDir,
  //   });
  //   // Process output for progress tracking
  //   const output = stdout + stderr;
  //   for (const line of output.split("\\n")) {
  //     logger.processLine(line);
  //   }
  //   logger.stop("Build completed successfully");
  //   const buildSettings = await prepareBuildArgs(xcodeProject);
  //   return {
  //     appPath: buildSettings.appPath,
  //     infoPlistPath: buildSettings.infoPlistPath,
  //     scheme: "Release",
  //     configuration: "Release",
  //   };
  // } catch (error) {
  //   logger.stop("Build failed", false);
  //   throw new Error(`Xcode build failed: ${error}`);
  // }
};
