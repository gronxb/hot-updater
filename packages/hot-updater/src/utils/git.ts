import { exec } from "child_process";

export const getLatestGitCommitMessage = () => {
  return new Promise<string | null>((resolve) => {
    exec("git log --decorate --pretty=format:%s -1", (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
};

export const getGitCommitHash = () => {
  return new Promise<string | null>((resolve) => {
    exec("git rev-parse HEAD", (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
};
