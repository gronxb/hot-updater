import { getCwd } from "@hot-updater/plugin-core";
import { openRepository } from "es-git";

export const getLatestGitCommit = async () => {
  const repo = await openRepository(getCwd());
  const revwalk = repo.revwalk().pushHead();

  for (const sha of revwalk) {
    const commit = repo.getCommit(sha);
    return commit;
  }

  return null;
};
