import path from "node:path";
import { execa } from "execa";
import * as p from "@clack/prompts";
import type { ApplePlatform } from "../utils/platformSupport";
import { createBuildPaths } from "../utils/buildPaths";
import { discoverXcodeProject, type XcodeProjectInfo } from "../utils/projectInfo";
import { createBuildMonitor } from "./buildMonitor";
import type { 
  BuildFlags, 
  BuildResult, 
  ArchiveOptions, 
  ExportOptions 
} from "./buildOptions";

/**
 * Main Xcode builder class that handles all build operations
 */
export class XcodeBuilder {
  private sourceDir: string;
  private platform: ApplePlatform;

  /**
   * Creates a new XcodeBuilder instance
   * @param sourceDir - Directory containing Xcode project
   * @param platform - Target Apple platform
   */
  constructor(sourceDir: string, platform: ApplePlatform) {
    this.sourceDir = sourceDir;
    this.platform = platform;
  }

  /**
   * Builds an iOS app without archiving
   * @param options - Build configuration options
   * @returns Build result with app path and metadata
   * 
   * @example
   * ```typescript
   * const builder = new XcodeBuilder("./ios", "ios");
   * const result = await builder.build({
   *   scheme: "MyApp",
   *   configuration: "Debug",
   *   installPods: true
   * });
   * console.log(result.appPath); // Path to .app file
   * ```
   */
  async build(options: BuildFlags): Promise<BuildResult> {
    const xcodeProject = await discoverXcodeProject(this.sourceDir);
    
    // Install CocoaPods if requested
    if (options.installPods) {
      await this.installPodsIfNeeded();
    }

    const buildArgs = this.prepareBuildArgs(xcodeProject, options, false);
    const monitor = createBuildMonitor();
    
    monitor.start(xcodeProject.name);
    
    try {
      const { stdout, stderr } = await execa("xcodebuild", buildArgs, {
        cwd: this.sourceDir,
      });

      // Process output for progress tracking
      const output = stdout + stderr;
      output.split("\\n").forEach(line => monitor.processLine(line));

      monitor.stop("Build completed successfully");

      const buildSettings = await this.getBuildSettings(xcodeProject, options);
      
      return {
        appPath: buildSettings.appPath,
        infoPlistPath: buildSettings.infoPlistPath,
        scheme: options.scheme || "Release",
        configuration: options.configuration || "Release",
      };
    } catch (error) {
      monitor.stop("Build failed", false);
      throw new Error(`Xcode build failed: ${error}`);
    }
  }

  /**
   * Archives an iOS app for distribution
   * @param options - Archive configuration options
   * @returns Archive path and metadata
   * 
   * @example
   * ```typescript
   * const builder = new XcodeBuilder("./ios", "ios");
   * const result = await builder.archive({
   *   scheme: "MyApp",
   *   buildConfiguration: "Release",
   *   platform: "ios"
   * });
   * console.log(result.archivePath); // Path to .xcarchive
   * ```
   */
  async archive(options: ArchiveOptions): Promise<{ archivePath: string }> {
    const xcodeProject = await discoverXcodeProject(this.sourceDir);
    const { archiveDir } = createBuildPaths(this.platform);
    
    const archiveName = `${xcodeProject.name.replace(".xcworkspace", "").replace(".xcodeproj", "")}.xcarchive`;
    const archivePath = path.join(archiveDir, archiveName);

    const archiveArgs = [
      xcodeProject.isWorkspace ? "-workspace" : "-project",
      path.join(this.sourceDir, xcodeProject.name),
      "-scheme",
      options.scheme,
      "-configuration", 
      options.buildConfiguration,
      "archive",
      "-archivePath",
      archivePath,
    ];

    if (options.xcconfig) {
      archiveArgs.push("-xcconfig", options.xcconfig);
    }

    if (options.extraParams) {
      archiveArgs.push(...options.extraParams);
    }

    const monitor = createBuildMonitor();
    monitor.start(`${xcodeProject.name} (Archive)`);

    try {
      const { stdout, stderr } = await execa("xcodebuild", archiveArgs, {
        cwd: this.sourceDir,
      });

      // Process output for progress tracking
      const output = stdout + stderr;
      output.split("\\n").forEach(line => monitor.processLine(line));

      monitor.stop("Archive completed successfully");

      return { archivePath };
    } catch (error) {
      monitor.stop("Archive failed", false);
      throw new Error(`Xcode archive failed: ${error}`);
    }
  }

  /**
   * Exports an archive to IPA
   * @param options - Export configuration options
   * @returns Export path containing IPA
   * 
   * @example
   * ```typescript
   * const builder = new XcodeBuilder("./ios", "ios");
   * const result = await builder.exportArchive({
   *   archivePath: "/path/to/app.xcarchive",
   *   exportOptionsPlist: "./ExportOptions.plist"
   * });
   * console.log(result.exportPath); // Directory containing IPA
   * ```
   */
  async exportArchive(options: ExportOptions): Promise<{ exportPath: string }> {
    const { exportDir } = createBuildPaths(this.platform);

    const exportArgs = [
      "-exportArchive",
      "-archivePath",
      options.archivePath,
      "-exportPath",
      exportDir,
      "-exportOptionsPlist",
      options.exportOptionsPlist,
    ];

    if (options.exportExtraParams) {
      exportArgs.push(...options.exportExtraParams);
    }

    const spinner = p.spinner();
    spinner.start("Exporting archive to IPA");

    try {
      await execa("xcodebuild", exportArgs, {
        cwd: this.sourceDir,
      });

      spinner.stop("Archive exported successfully");
      return { exportPath: exportDir };
    } catch (error) {
      spinner.stop("Export failed");
      throw new Error(`Archive export failed: ${error}`);
    }
  }

  /**
   * Prepares xcodebuild arguments
   * @param xcodeProject - Xcode project information
   * @param options - Build options
   * @param isArchive - Whether this is an archive build
   * @returns Array of xcodebuild arguments
   */
  private prepareBuildArgs(
    xcodeProject: XcodeProjectInfo,
    options: BuildFlags,
    isArchive: boolean = false
  ): string[] {
    const args = [
      xcodeProject.isWorkspace ? "-workspace" : "-project",
      xcodeProject.name,
    ];

    if (options.buildFolder) {
      args.push("-derivedDataPath", options.buildFolder);
    }

    args.push(
      "-configuration", options.configuration || "Release",
      "-scheme", options.scheme || "Release"
    );

    if (options.destination) {
      options.destination.forEach(dest => {
        args.push("-destination", this.resolveDestination(dest));
      });
    }

    if (isArchive) {
      const { archiveDir } = createBuildPaths(this.platform);
      const archiveName = `${xcodeProject.name.replace(".xcworkspace", "").replace(".xcodeproj", "")}.xcarchive`;
      args.push(
        "-archivePath",
        path.join(archiveDir, archiveName),
        "archive"
      );
    } else {
      args.push("build");
    }

    if (options.extraParams) {
      args.push(...options.extraParams);
    }

    return args;
  }

  /**
   * Resolves destination string to xcodebuild format
   * @param destination - Destination string (device, simulator, or xcodebuild format)
   * @returns Resolved destination string
   */
  private resolveDestination(destination: string): string {
    if (destination === "device") {
      return `generic/platform=${this.platform === "ios" ? "iOS" : this.platform}`;
    }
    if (destination === "simulator") {
      return `generic/platform=${this.platform === "ios" ? "iOS" : this.platform} Simulator`;
    }
    return destination;
  }

  /**
   * Gets build settings from xcodebuild
   * @param xcodeProject - Xcode project information
   * @param options - Build options
   * @returns Build settings including app path
   */
  private async getBuildSettings(
    xcodeProject: XcodeProjectInfo,
    options: BuildFlags
  ): Promise<{ appPath: string; infoPlistPath: string }> {
    const buildSettingsArgs = [
      xcodeProject.isWorkspace ? "-workspace" : "-project",
      xcodeProject.name,
      "-scheme",
      options.scheme || "Release",
      "-configuration",
      options.configuration || "Release",
      "-showBuildSettings",
      "-json",
    ];

    if (options.buildFolder) {
      buildSettingsArgs.push("-derivedDataPath", options.buildFolder);
    }

    try {
      const { stdout } = await execa("xcodebuild", buildSettingsArgs, {
        cwd: this.sourceDir,
      });

      const buildSettings = JSON.parse(stdout);
      const target = buildSettings[0];
      const settings = target.buildSettings;
      
      const productName = settings.PRODUCT_NAME;
      const configurationBuildDir = settings.CONFIGURATION_BUILD_DIR;
      const appPath = path.join(configurationBuildDir, `${productName}.app`);
      const infoPlistPath = path.join(appPath, "Info.plist");

      return { appPath, infoPlistPath };
    } catch (error) {
      throw new Error(`Failed to get build settings: ${error}`);
    }
  }

  /**
   * Installs CocoaPods if needed
   * TODO: Implement advanced CocoaPods features:
   * - Bundle/Gemfile support for Ruby dependency management
   * - Dependency hash caching to avoid unnecessary installs
   * - Automatic repo update handling when installation fails
   * - Environment variable support (RCT_NEW_ARCH_ENABLED, etc.)
   * - Codegen integration before pod install
   * - Build folder cleanup to avoid path clashes
   */
  private async installPodsIfNeeded(): Promise<void> {
    const podfilePath = path.join(this.sourceDir, "Podfile");
    
    try {
      // Check if Podfile exists
      await execa("test", ["-f", podfilePath]);
      
      const spinner = p.spinner();
      spinner.start("Installing CocoaPods dependencies");
      
      try {
        await execa("pod", ["install"], { cwd: this.sourceDir });
        spinner.stop("CocoaPods dependencies installed");
      } catch (error) {
        spinner.stop("CocoaPods installation failed");
        throw new Error(`pod install failed: ${error}`);
      }
    } catch {
      // Podfile doesn't exist, skip pod install
      p.log.info("No Podfile found, skipping CocoaPods installation");
    }
  }
}

/**
 * Creates a new XcodeBuilder instance
 * @param sourceDir - Directory containing Xcode project
 * @param platform - Target Apple platform
 * @returns New XcodeBuilder instance
 */
export const createXcodeBuilder = (sourceDir: string, platform: ApplePlatform): XcodeBuilder => {
  return new XcodeBuilder(sourceDir, platform);
};