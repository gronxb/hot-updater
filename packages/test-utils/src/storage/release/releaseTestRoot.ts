import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const createdRoots = new Set<string>();

export const createReleaseTestRoot = (prefix: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  createdRoots.add(root);
  return root;
};

export const cleanupReleaseTestRoots = (): void => {
  for (const root of createdRoots) {
    rmSync(root, { force: true, recursive: true });
    createdRoots.delete(root);
  }
};
