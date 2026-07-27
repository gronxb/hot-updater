import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import {
  createEvidenceFixture,
  type EvidenceFixture,
  type FixtureReceipt,
  writeFixtureReceipt,
} from "./evidenceFixture";
import { createReleaseTestRoot } from "./releaseTestRoot";

type CompletionOptions = Readonly<{
  driver: string;
  finalSha: string;
  workspace: string;
}>;

const receiptFor = (fixture: EvidenceFixture, task: string): FixtureReceipt => {
  const receipt = fixture.receipts.get(task);
  if (receipt === undefined) {
    throw new TypeError(`Fixture receipt ${task} is missing.`);
  }
  return receipt;
};

const receiptPathFor = (fixture: EvidenceFixture, task: string): string => {
  const receiptPath = fixture.receiptPaths.get(task);
  if (receiptPath === undefined) {
    throw new TypeError(`Fixture receipt path ${task} is missing.`);
  }
  return receiptPath;
};

const expectCompletionFailure = (
  options: CompletionOptions,
  fixture: EvidenceFixture,
  root: string,
  label: string,
  invariant: string,
  output = path.join(root, `${label}.json`),
): void => {
  const result = spawnSync(
    process.execPath,
    [
      options.driver,
      "--mode",
      "completion",
      "--evidence-dir",
      fixture.evidenceDirectory,
      "--sha",
      options.finalSha,
      "--output",
      output,
    ],
    { cwd: options.workspace, encoding: "utf8" },
  );
  const receipt = JSON.parse(result.stdout.length > 0 ? result.stdout : "{}");
  const persisted = JSON.parse(readFileSync(output, "utf8"));
  expect(receipt).toEqual({});
  expect(result.status).not.toBe(0);
  expect(persisted.verdict).toBe("failed");
  expect(persisted.details.invariant).toBe(invariant);
};

export const registerIntentionalCompletionCases = (
  options: CompletionOptions,
): void => {
  for (const task of ["F1", "F2", "F3", "F4"] as const) {
    it(`rejects completion with missing ${task}`, () => {
      const root = createReleaseTestRoot(
        `storage-v2-completion-${task.toLowerCase()}-`,
      );
      const fixture = createEvidenceFixture(
        root,
        options.workspace,
        options.finalSha,
        true,
      );
      rmSync(receiptPathFor(fixture, task));

      expectCompletionFailure(
        options,
        fixture,
        root,
        `missing-${task.toLowerCase()}`,
        `missing-current-final:${task}`,
      );
    });
  }

  it("rejects completion with a self-referential input", () => {
    const root = createReleaseTestRoot("storage-v2-completion-self-");
    const fixture = createEvidenceFixture(
      root,
      options.workspace,
      options.finalSha,
      true,
    );
    const output = path.join(
      fixture.evidenceDirectory,
      "artifacts/completion/final-completion.json",
    );
    mkdirSync(path.dirname(output), { recursive: true });
    writeFixtureReceipt(receiptPathFor(fixture, "F4"), {
      ...receiptFor(fixture, "F4"),
      artifacts: [
        {
          path: "artifacts/completion/final-completion.json",
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      ],
    });

    expectCompletionFailure(
      options,
      fixture,
      root,
      "self-reference",
      "completion-self-reference",
      output,
    );
  });
};
