import { getCwd } from "@hot-updater/plugin-core";
import { type Commit, openRepository } from "es-git";

export const getLatestGitCommit = async (): Promise<Commit | null> => {
  try {
    const repo = await openRepository(getCwd());
    const headSha = repo.revparse("HEAD").from;
    if (headSha) {
      return repo.getCommit(headSha);
    }

    return null;
  } catch (error) {
    return null;
  }
};
