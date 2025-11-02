import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { getCwd } from "@hot-updater/plugin-core";

const execAsync = promisify(exec);

/**
 * Commit class compatible with es-git's Commit interface
 */
class Commit {
  constructor(
    private readonly commitHash: string,
    private readonly commitMessage: string | null,
  ) {}

  id(): string {
    return this.commitHash;
  }

  summary(): string | null {
    return this.commitMessage;
  }
}

export const getLatestGitCommit = async (): Promise<Commit | null> => {
  try {
    const cwd = getCwd();

    // Get commit hash
    const { stdout: hash } = await execAsync("git rev-parse HEAD", { cwd });
    const commitHash = hash.trim();

    if (!commitHash) {
      return null;
    }

    // Get commit message (first line only)
    const { stdout: message } = await execAsync("git log -1 --format=%s", {
      cwd,
    });
    const commitMessage = message.trim() || null;

    return new Commit(commitHash, commitMessage);
  } catch {
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
}: {
  cwd?: string;
  globLines: string[];
}): boolean => {
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

    // Ensure there's a newline before appending if the file doesn't end with one
    const needsNewlineBefore = content.length > 0 && !content.endsWith("\n");
    const textToAppend = [comment, ...willAppendedLines].join("\n");

    fs.appendFileSync(
      gitIgnorePath,
      `${needsNewlineBefore ? "\n" : ""}${textToAppend}\n`,
      {
        encoding: "utf8",
      },
    );
  } else {
    fs.writeFileSync(gitIgnorePath, `${[comment, ...globLines].join("\n")}\n`, {
      encoding: "utf8",
    });
  }
  return true;
};
