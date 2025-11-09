import { p } from "@hot-updater/cli-tools";
import { execa } from "execa";
import { XMLParser } from "fast-xml-parser";
import fs from "fs";
import path from "path";

/**
 * Xcode project information
 */
export interface XcodeProjectInfo {
  /** Whether this is a workspace or project */
  isWorkspace: boolean;
  /** Name of the workspace or project file */
  name: string;
  /** Full path to the workspace or project */
  path: string;
}

/**
 * Xcode project/workspace information from xcodebuild -list
 */
export interface ProjectInfo {
  /** Available schemes */
  schemes: string[];
  /** Available configurations */
  configurations: string[];
  /** Available targets */
  targets?: string[];
  /** Name of the project */
  name?: string;
}

/**
 * Parses xcodebuild -list JSON output
 * @param json - JSON string from xcodebuild -list -json
 * @returns Parsed project information
 * @throws Error if JSON cannot be parsed
 */
const parseTargetList = (json: string): ProjectInfo | undefined => {
  try {
    const info = JSON.parse(json);

    if ("project" in info) {
      return info.project;
    }
    if ("workspace" in info) {
      return info.workspace;
    }

    return undefined;
  } catch (error) {
    throw new Error(`Failed to parse target list: ${error}`);
  }
};

/**
 * Discovers Xcode project or workspace in a directory
 */
export const discoverXcodeProject = async (
  sourceDir: string,
): Promise<XcodeProjectInfo> => {
  const files = await fs.promises.readdir(sourceDir);

  // Look for workspace first (preferred)
  const workspace = files.find((file) => file.endsWith(".xcworkspace"));
  if (workspace) {
    return {
      isWorkspace: true,
      name: workspace,
      path: path.join(sourceDir, workspace),
    };
  }

  // Fall back to project
  const project = files.find((file) => file.endsWith(".xcodeproj"));
  if (project) {
    return {
      isWorkspace: false,
      name: project,
      path: path.join(sourceDir, project),
    };
  }

  throw new Error(`No Xcode project or workspace found in ${sourceDir}`);
};

/**
 * Gets detailed information about an Xcode project or workspace
 * @param projectInfo - Basic project information
 * @param sourceDir - Source directory containing the project
 * @returns Detailed project information including schemes and configurations
 * @throws Error if project information cannot be retrieved
 *
 * @example
 * ```typescript
 * const projectInfo = await discoverXcodeProject("./ios");
 * const details = await getProjectInfo(projectInfo, "./ios");
 * console.log(details.schemes); // ["MyApp", "MyAppTests"]
 * ```
 */
export const getProjectInfo = async (
  projectInfo: XcodeProjectInfo,
  sourceDir: string,
): Promise<ProjectInfo | undefined> => {
  const spinner = p.spinner();
  spinner.start("Gathering Xcode project information");

  try {
    // Handle single project
    if (!projectInfo.isWorkspace) {
      const { stdout } = await execa("xcodebuild", ["-list", "-json"], {
        cwd: sourceDir,
      });
      const info = parseTargetList(stdout);

      if (!info) {
        spinner.stop("Failed: Gathering Xcode project information");
        throw new Error("Failed to get Xcode project information");
      }

      spinner.stop("Gathered Xcode project information");
      return info;
    }

    // Handle workspace with multiple projects
    const xmlParser = new XMLParser({ ignoreAttributes: false });
    const xcworkspacedata = path.join(
      sourceDir,
      projectInfo.name,
      "contents.xcworkspacedata",
    );

    const workspace = fs.readFileSync(xcworkspacedata, { encoding: "utf-8" });
    const fileRef = xmlParser.parse(workspace).Workspace.FileRef;
    const refs = Array.isArray(fileRef) ? fileRef : [fileRef];
    const locations = refs
      .map((ref) => ref["@_location"])
      .filter(
        (location: string) =>
          !location.endsWith("/Pods.xcodeproj") && // Ignore CocoaPods project
          location.endsWith(".xcodeproj"), // Only project files
      );

    let info: ProjectInfo | undefined;

    for (const location of locations) {
      try {
        const { stdout } = await execa(
          "xcodebuild",
          ["-list", "-json", "-project", location.replace("group:", "")],
          { cwd: sourceDir },
        );

        const projectInfo = parseTargetList(stdout);
        if (!projectInfo) {
          continue;
        }

        const schemes = projectInfo.schemes;

        // If this is the first project, use it as the "main" project
        if (!info) {
          if (!Array.isArray(schemes)) {
            projectInfo.schemes = [];
          }
          info = projectInfo;
          continue;
        }

        if (!Array.isArray(info.schemes)) {
          throw new Error("Schemes should be an array at this point");
        }

        // For subsequent projects, merge schemes list
        if (Array.isArray(schemes) && schemes.length > 0) {
          info.schemes = info.schemes.concat(schemes);
        }
      } catch (error) {
        p.log.warn(`Failed to get info for project ${location}: ${error}`);
      }
    }

    spinner.stop("Gathered Xcode project information");
    return info;
  } catch (error) {
    spinner.stop("Failed to gather Xcode project information");
    throw new Error(`Failed to get project information: ${error}`);
  }
};

/**
 * Gets available schemes for a project
 * @param sourceDir - Directory containing the Xcode project
 * @returns Array of available scheme names
 *
 * @example
 * ```typescript
 * const schemes = await getAvailableSchemes("./ios");
 * console.log(schemes); // ["MyApp", "MyAppTests"]
 * ```
 */
export const getAvailableSchemes = async (
  sourceDir: string,
): Promise<string[]> => {
  const projectInfo = await discoverXcodeProject(sourceDir);
  const info = await getProjectInfo(projectInfo, sourceDir);
  return info?.schemes || [];
};

/**
 * Gets available configurations for a project
 * @param sourceDir - Directory containing the Xcode project
 * @returns Array of available configuration names
 *
 * @example
 * ```typescript
 * const configs = await getAvailableConfigurations("./ios");
 * console.log(configs); // ["Debug", "Release"]
 * ```
 */
export const getAvailableConfigurations = async (
  sourceDir: string,
): Promise<string[]> => {
  const projectInfo = await discoverXcodeProject(sourceDir);
  const info = await getProjectInfo(projectInfo, sourceDir);
  return info?.configurations || [];
};

// TODO: Add advanced project discovery features
// - Swift Package Manager integration and dependency analysis
// - Xcode build settings extraction and validation
// - Target dependency mapping and build order optimization
// - Project health checks (missing files, broken references)
// - Automatic scheme and configuration recommendation based on project structure
