import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const assertVerifierReceipt = (
  output: string,
  mode: "evidence" | "completion",
  sha: string,
) => {
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  expect(receipt).toMatchObject({
    schema: "hot-updater.storage-v2-verifier/v1",
    mode,
    observedSha: sha,
    verdict: "passed",
    commands: [],
  });
  expect(receipt.details.sourceBinding).toMatchObject({
    headSha: sha,
  });
  const sourcesContainedInHead =
    receipt.details.sourceBinding.uncommittedPaths.length === 0;
  expect(receipt.details.sourceBinding.sourcesContainedInHead).toBe(
    sourcesContainedInHead,
  );
  expect(receipt.details.sourceBinding.requiredPostCommitEpoch).toBe(
    !sourcesContainedInHead,
  );
  expect(receipt.details.sourceBinding.releaseReady).toBe(
    sourcesContainedInHead,
  );
  expect(receipt.details.sourceBinding.requiredResult).toBe(
    sourcesContainedInHead ? "none" : "post-commit-epoch",
  );
  expect(receipt.details.sourceBinding.status).toBe(
    sourcesContainedInHead ? "commit-contained" : "precommit-uncontained",
  );
  expect(receipt.details.sourceBinding.headTreeSha).toMatch(/^[0-9a-f]{40}$/);
  expect(receipt.details.sourceBinding.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  return receipt;
};

export const assertFixtureReceipts = (
  evidenceDirectory: string,
  receiptPaths: readonly string[],
): void => {
  const groups = new Map<string, number[]>();
  for (const receiptPath of receiptPaths) {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.commandOrdinal).toBeGreaterThan(0);
    expect(receipt.commandCount).toBeGreaterThan(0);
    const key = `${receipt.task}:${receipt.phase}:${receipt.runOrdinal}`;
    groups.set(key, [...(groups.get(key) ?? []), receipt.commandOrdinal]);
    const artifactPaths = receipt.artifacts.map(
      (artifact: Readonly<{ path: string }>) => artifact.path,
    );
    expect(artifactPaths).toEqual([...artifactPaths].sort());
    for (const artifact of receipt.artifacts) {
      expect(artifact.path).toBe(path.posix.normalize(artifact.path));
      expect(
        sha256(readFileSync(path.join(evidenceDirectory, artifact.path))),
      ).toBe(artifact.sha256);
    }
  }
  for (const ordinals of groups.values()) {
    expect([...ordinals].sort((left, right) => left - right)).toEqual(
      Array.from({ length: ordinals.length }, (_, index) => index + 1),
    );
  }
};
