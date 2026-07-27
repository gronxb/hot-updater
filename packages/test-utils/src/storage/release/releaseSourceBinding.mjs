import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { currentSha, runCommand, sha256 } from "./driverSupport.mjs";

const SOURCE_PATHS = [
  "packages/test-utils/src/storage/release",
  "scripts/verify-storage-v2.mjs",
];

export const createReleaseSourceBinding = (workspace) => {
  const fileList = runCommand(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...SOURCE_PATHS,
    ],
    workspace,
  );
  if (fileList.exitCode !== 0) {
    throw new TypeError("Unable to enumerate release verifier sources.");
  }
  const files = fileList.stdout
    .split("\n")
    .filter(Boolean)
    .filter((relativePath) =>
      statSync(path.resolve(workspace, relativePath)).isFile(),
    )
    .sort()
    .map((relativePath) => ({
      path: relativePath,
      sha256: sha256(readFileSync(path.resolve(workspace, relativePath))),
    }));
  const sourceStatus = runCommand(
    [
      "git",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...SOURCE_PATHS,
    ],
    workspace,
  );
  if (sourceStatus.exitCode !== 0) {
    throw new TypeError("Unable to inspect release verifier source state.");
  }
  const uncommittedPaths = sourceStatus.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  const headTree = runCommand(["git", "rev-parse", "HEAD^{tree}"], workspace);
  if (headTree.exitCode !== 0) {
    throw new TypeError("Unable to resolve the tested commit tree.");
  }
  const sourcesContainedInHead = uncommittedPaths.length === 0;
  return {
    headSha: currentSha(workspace),
    headTreeSha: headTree.stdout.trim(),
    sourceSha256: sha256(JSON.stringify(files)),
    files,
    uncommittedPaths,
    sourcesContainedInHead,
    requiredPostCommitEpoch: !sourcesContainedInHead,
    requiredResult: sourcesContainedInHead ? "none" : "post-commit-epoch",
    releaseReady: sourcesContainedInHead,
    status: sourcesContainedInHead
      ? "commit-contained"
      : "precommit-uncontained",
  };
};
