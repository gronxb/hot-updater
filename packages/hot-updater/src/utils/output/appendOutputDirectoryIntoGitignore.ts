import { appendToProjectRootGitignore } from "../git";

export const appendOutputDirectoryIntoGitignore = ({
  cwd,
}: {
  cwd?: string;
} = {}) => {
  const appendedLines = [".hot-updater/output"];
  return appendToProjectRootGitignore({ cwd, globLines: appendedLines });
};
