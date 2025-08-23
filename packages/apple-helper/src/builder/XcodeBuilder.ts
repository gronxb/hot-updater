import fs from "fs";
import os from "os";
import path from "path";
import * as p from "@clack/prompts";
import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import { execa } from "execa";
import { installPodsIfNeeded } from "../utils/cocoapods";
import {
  getDefaultDestination,
  resolveDestinations,
} from "../utils/destination";
import {
  type XcodeProjectInfo,
  discoverXcodeProject,
} from "../utils/projectInfo";
import { XcodebuildLogger } from "./XcodebuildLogger";
import type {
  ArchiveOptions,
  BuildResult,
  ExportOptions,
} from "./buildOptions";

const getTmpResultDir = () => path.join(os.tmpdir(), "archive");
export class XcodeBuilder {
  private readonly sourceDir: string;

  constructor(sourceDir: string) {
    this.sourceDir = sourceDir;
  }

  async archive({
    outputPath,
    platform,
    schemeConfig,
  }: ArchiveOptions): Promise<{ archivePath: string }> {
    const xcodeProject = await discoverXcodeProject(this.sourceDir);

    if (schemeConfig.installPods ?? true) {
      await installPodsIfNeeded(this.sourceDir);
    }

    const tmpResultDir = getTmpResultDir();
    await fs.promises.mkdir(tmpResultDir, { recursive: true });

    const archiveName = `${xcodeProject.name.replace(".xcworkspace", "").replace(".xcodeproj", "")}.xcarchive`;
    const archivePath = path.join(tmpResultDir, archiveName);

    const archiveArgs = this.prepareArchiveArgs({
      archiveOptions: { outputPath, platform, schemeConfig },
      archivePath,
      xcodeProject,
    });

    p.log.info(`Xcode Archive Settings:
Project    ${xcodeProject.name}
Scheme     ${schemeConfig.scheme}
Platform   ${platform}
Command    xcodebuild ${archiveArgs.join(" ")}
`);

    const logger = new XcodebuildLogger();
    logger.start(`${xcodeProject.name} (Archive)`);

    try {
      const process = execa("xcodebuild", archiveArgs, {
        cwd: this.sourceDir,
      });

      for await (const line of process) {
        console.log(line);
        logger.processLine(line);
      }

      logger.stop("Archive completed successfully");

      return { archivePath };
    } catch (error) {
      logger.stop("Archive failed", false);
      throw new Error(`Xcode archive failed: ${error}`);
    }
  }

  /**
   * Prepares xcodebuild archive arguments
   */
  private prepareArchiveArgs({
    xcodeProject,
    archiveOptions: { schemeConfig, platform },
    archivePath,
  }: {
    xcodeProject: XcodeProjectInfo;
    archiveOptions: ArchiveOptions;
    archivePath: string;
  }): string[] {
    const args = [
      xcodeProject.isWorkspace ? "-workspace" : "-project",
      path.join(this.sourceDir, xcodeProject.name),
      "-scheme",
      schemeConfig.scheme,
      "-configuration",
      schemeConfig.configuration || "Release",
      "archive",
      "-archivePath",
      archivePath,
    ];

    if (schemeConfig.xcconfig) {
      args.push("-xcconfig", schemeConfig.xcconfig);
    }

    if (schemeConfig.extraParams) {
      args.push(...schemeConfig.extraParams);
    }

    const resolvedDestinations = resolveDestinations({
      destinations: schemeConfig.destination || [],
      useGeneric: true,
    });
    if (resolvedDestinations.length === 0) {
      resolvedDestinations.push(
        getDefaultDestination({
          platform,
          useGeneric: true,
        }),
      );
    }

    for (const destination of resolvedDestinations) {
      args.push("-destination", destination);
    }

    return args;
  }

  /**
   * Exports an archive to IPA
   */
  async exportArchive(options: ExportOptions): Promise<{ exportPath: string }> {
    const exportPath = path.join(getTmpResultDir(), "export");
    const exportArgs = this.prepareExportArgs({
      exportOptions: options,
      exportPath,
    });

    const spinner = p.spinner();
    spinner.start("Exporting archive to IPA");

    try {
      await execa("xcodebuild", exportArgs, {
        cwd: this.sourceDir,
      });

      spinner.stop("Archive exported successfully");
      return { exportPath };
    } catch (error) {
      spinner.stop("Export failed");
      throw new Error(`Archive export failed: ${error}`);
    }
  }
  /**
   * Prepares xcodebuild export arguments
   */
  private prepareExportArgs({
    exportPath,
    exportOptions: { archivePath, schemeConfig },
  }: { exportOptions: ExportOptions; exportPath: string }): string[] {
    const args = [
      "-exportArchive",
      "-archivePath",
      archivePath,
      "-exportPath",
      exportPath,
    ];

    if (schemeConfig.exportExtraParams) {
      args.push(...schemeConfig.exportExtraParams);
    }
    if (schemeConfig.exportOptionsPlist) {
      args.push("-exportOptionsPlist", schemeConfig.exportOptionsPlist);
    }
    return args;
  }

  /**
   * Builds an iOS app without archiving
   */
  async build({
    scheme: { installPods },
  }: { scheme: NativeBuildIosScheme }): Promise<BuildResult> {
    return {
      appPath: "",
      configuration: "",
      infoPlistPath: "",
      scheme: "",
      archivePath: "",
      exportPath: "",
    };
    // const xcodeProject = await discoverXcodeProject(this.sourceDir);
    // // Install CocoaPods if requested
    // if (installPods) {
    //   await this.installPodsIfNeeded();
    // }
    // const buildArgs = this.prepareBuildArgs(xcodeProject);
    // const logger = new XcodebuildLogger();
    // logger.start(xcodeProject.name);
    // try {
    //   const { stdout, stderr } = await execa("xcodebuild", buildArgs, {
    //     cwd: this.sourceDir,
    //   });
    //   // Process output for progress tracking
    //   const output = stdout + stderr;
    //   for (const line of output.split("\\n")) {
    //     logger.processLine(line);
    //   }
    //   logger.stop("Build completed successfully");
    //   const buildSettings = await this.prepareBuildArgs(xcodeProject);
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
  }
}

export const createXcodeBuilder = (sourceDir: string): XcodeBuilder => {
  return new XcodeBuilder(sourceDir);
};
