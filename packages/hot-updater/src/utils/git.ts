import fs from "fs";
import path from "path";
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

/**
 * append globLines into project's .gitignore
 *
 * @returns whether .gitignore was changed
 */
export const appendToProjectRootGitignore = ({
  cwd,
  globLines,
}: { cwd?: string; globLines: string[] }): boolean => {
  if (!globLines.length) {
    return false;
  }
  const comment = "# hot-updater";

  const projectDir = cwd ?? getCwd();
  const gitIgnorePath = path.join(projectDir, ".gitignore");

  if (fs.existsSync(gitIgnorePath)) {
    const content = fs.readFileSync(gitIgnorePath, { encoding: "utf8" });

    const allLines = content.split(/\r?\n/);
    const willAppendedLines: string[] = [];
    for (const line of globLines) {
      if (!allLines.find((l) => l.trim() === line)) {
        willAppendedLines.push(line);
      }
    }

    if (!willAppendedLines.length) {
      return false;
    }

    fs.appendFileSync(
      gitIgnorePath,
      [comment, ...willAppendedLines].join("\n"),
      {
        encoding: "utf8",
      },
    );
  } else {
    fs.writeFileSync(gitIgnorePath, [comment, ...globLines].join("\n"), {
      encoding: "utf8",
    });
  }
  return true;
};
