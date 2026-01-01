import fs from "fs";
import path from "path";

export interface XcodeProjectInfo {
  isWorkspace: boolean;
  name: string;
  path: string;
}

export const parseXcodeProjectInfo = async (
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
