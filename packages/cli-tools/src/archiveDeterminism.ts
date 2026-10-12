import fs from "fs/promises";
import path from "path";

export const compareArchivePaths = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export async function getSortedArchiveEntries(
  rootDir: string,
  relativeDir = "",
): Promise<string[]> {
  const directory = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const archiveEntries: string[] = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    archiveEntries.push(relativePath);

    if (entry.isDirectory()) {
      archiveEntries.push(
        ...(await getSortedArchiveEntries(rootDir, relativePath)),
      );
    }
  }

  return archiveEntries.sort(compareArchivePaths);
}

export const normalizeTarEntryMode = (entry: {
  stat?: { mode: number };
  type?: string;
}) => {
  if (entry.stat) {
    entry.stat.mode = entry.type === "Directory" ? 0o755 : 0o644;
  }
};
