import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import {
  createEvidenceFixture,
  type EvidenceFixture,
  type FixtureReceipt,
} from "./evidenceFixture";
import { createReleaseTestRoot } from "./releaseTestRoot";

export type IntentionalEvidenceOptions = Readonly<{
  driver: string;
  finalSha: string;
  workspace: string;
}>;

export const receiptFor = (
  fixture: EvidenceFixture,
  task: string,
): FixtureReceipt => {
  const receipt = fixture.receipts.get(task);
  if (receipt === undefined) {
    throw new TypeError(`Fixture receipt ${task} is missing.`);
  }
  return receipt;
};

export const receiptPathFor = (
  fixture: EvidenceFixture,
  task: string,
): string => {
  const receiptPath = fixture.receiptPaths.get(task);
  if (receiptPath === undefined) {
    throw new TypeError(`Fixture receipt path ${task} is missing.`);
  }
  return receiptPath;
};

export const prepareFixture = (
  options: IntentionalEvidenceOptions,
): Readonly<{ fixture: EvidenceFixture; root: string }> => {
  const root = createReleaseTestRoot("storage-v2-evidence-fail-");
  const fixture = createEvidenceFixture(
    root,
    options.workspace,
    options.finalSha,
    false,
  );
  writeFileSync(
    path.join(fixture.evidenceDirectory, "pr.json"),
    JSON.stringify({
      state: "OPEN",
      isDraft: false,
      headRefOid: options.finalSha,
    }),
  );
  return { fixture, root };
};

export const expectEvidenceFailure = (
  options: IntentionalEvidenceOptions,
  fixture: EvidenceFixture,
  root: string,
  label: string,
  invariant: string,
): void => {
  const output = path.join(root, `${label}.json`);
  const result = spawnSync(
    process.execPath,
    [
      options.driver,
      "--mode",
      "evidence",
      "--plan",
      fixture.planPath,
      "--evidence-dir",
      fixture.evidenceDirectory,
      "--sha",
      options.finalSha,
      "--pr-json",
      path.join(fixture.evidenceDirectory, "pr.json"),
      "--output",
      output,
    ],
    { cwd: options.workspace, encoding: "utf8" },
  );
  const persisted = JSON.parse(readFileSync(output, "utf8"));
  expect(result.status).not.toBe(0);
  expect(persisted.verdict).toBe("failed");
  expect(persisted.details.invariant).toBe(invariant);
};
