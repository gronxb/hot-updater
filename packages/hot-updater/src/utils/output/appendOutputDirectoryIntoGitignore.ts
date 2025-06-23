import { appendToProjectRootGitignore } from "../git";

export const appendOutputDirectoryIntoGitignore = ({
  cwd,
}: { cwd?: string } = {}) => {
  const appendedLines = [".hot-updater/output"];
  appendToProjectRootGitignore({ cwd, globLines: appendedLines });
};
