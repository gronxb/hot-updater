import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createEvidenceFixture, writeFixtureReceipt } from "./evidenceFixture";
import {
  assertFixtureReceipts,
  assertVerifierReceipt,
  sha256,
} from "./evidenceOutputAssertions";

const workspace = path.resolve(import.meta.dirname, "../../../../..");
const driver = path.join(workspace, "scripts/verify-storage-v2.mjs");

const runDriver = (arguments_: readonly string[]) =>
  spawnSync(process.execPath, [driver, ...arguments_], {
    cwd: workspace,
    encoding: "utf8",
  });

describe("Storage v2 release driver", () => {
  it("writes a SHA-bound matrix receipt", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "storage-v2-matrix-"));
    const output = path.join(directory, "matrix.json");
    execFileSync(process.execPath, [
      driver,
      "--mode",
      "matrix",
      "--output",
      output,
      "--fixture",
      path.join(
        workspace,
        "packages/test-utils/src/storage/release/fixtures/matrix-happy.json",
      ),
    ]);

    const receipt = JSON.parse(readFileSync(output, "utf8"));
    expect(receipt).toMatchObject({
      schema: "hot-updater.storage-v2-verifier/v1",
      mode: "matrix",
      verdict: "passed",
    });
    expect(receipt.observedSha).toBe(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspace,
        encoding: "utf8",
      }).trim(),
    );
    expect(receipt.commands).toHaveLength(1);
  });

  it("exits nonzero for a flipped matrix fixture", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "storage-v2-matrix-"));
    const result = runDriver([
      "--mode",
      "matrix",
      "--output",
      path.join(directory, "matrix.json"),
      "--fixture",
      path.join(
        workspace,
        "packages/test-utils/src/storage/release/fixtures/matrix-flipped.json",
      ),
    ]);

    expect(result.status).not.toBe(0);
  });

  it("rejects a forbidden simulated scope path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "storage-v2-scope-"));
    const result = runDriver([
      "--mode",
      "scope",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--simulate-path",
      "packages/console/src/index.ts",
      "--output",
      path.join(directory, "scope.json"),
    ]);

    expect(result.status).not.toBe(0);
  });

  it("accepts an empty in-scope diff", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "storage-v2-scope-"));
    const result = runDriver([
      "--mode",
      "scope",
      "--base",
      "HEAD",
      "--head",
      "HEAD",
      "--output",
      path.join(directory, "scope.json"),
    ]);

    expect(result.status).toBe(0);
  });

  it("accepts complete ancestor and exact-final evidence epochs", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "storage-v2-evidence-"));
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const fixture = createEvidenceFixture(directory, workspace, sha, false);
    const ancestorSha = execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const task1Path = fixture.receiptPaths.get("1");
    const task24Path = fixture.receiptPaths.get("24");
    const task1 = fixture.receipts.get("1");
    const task24 = fixture.receipts.get("24");
    if (
      task1Path === undefined ||
      task24Path === undefined ||
      task1 === undefined ||
      task24 === undefined
    ) {
      throw new TypeError("Evidence fixture is incomplete.");
    }
    writeFixtureReceipt(task1Path, { ...task1, observedSha: ancestorSha });
    const relativeArtifact =
      "artifacts/24/final/run-2/current-supersession.txt";
    const artifactPath = path.join(fixture.evidenceDirectory, relativeArtifact);
    const artifactContent = `task=24\nsha=${sha}\nrun=2\n`;
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, artifactContent);
    const run2ReceiptPath = path.join(
      fixture.evidenceDirectory,
      "receipts/24/final/run-2/command-1.json",
    );
    writeFixtureReceipt(run2ReceiptPath, {
      ...task24,
      runOrdinal: 2,
      artifacts: [{ path: relativeArtifact, sha256: sha256(artifactContent) }],
    });
    writeFixtureReceipt(task24Path, {
      ...task24,
      observedSha: ancestorSha,
    });
    const prPath = path.join(directory, "pr.json");
    writeFileSync(
      prPath,
      JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: sha }),
    );
    const output = path.join(directory, "evidence.json");
    const result = runDriver([
      "--mode",
      "evidence",
      "--plan",
      ".omo/plans/storage-v2.md",
      "--evidence-dir",
      fixture.evidenceDirectory,
      "--sha",
      sha,
      "--pr-json",
      prPath,
      "--output",
      output,
    ]);

    expect(result.status).toBe(0);
    const receipt = assertVerifierReceipt(output, "evidence", sha);
    expect(receipt.details).toMatchObject({
      historicalReceiptCount: 23,
      currentReceiptCount: 5,
    });
    expect(receipt.details.selected).toContainEqual({
      task: "24",
      phase: "final",
      runOrdinal: 2,
      commandCount: 1,
      observedSha: sha,
    });
    assertFixtureReceipts(fixture.evidenceDirectory, [
      ...fixture.receiptPaths.values(),
      run2ReceiptPath,
    ]);
  });

  it("accepts non-self-referential complete F1-F4 evidence", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "storage-v2-completion-"),
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const fixture = createEvidenceFixture(directory, workspace, sha, true);
    const output = path.join(directory, "completion.json");
    const result = runDriver([
      "--mode",
      "completion",
      "--evidence-dir",
      fixture.evidenceDirectory,
      "--sha",
      sha,
      "--output",
      output,
    ]);

    expect(result.status).toBe(0);
    const receipt = assertVerifierReceipt(output, "completion", sha);
    expect(receipt.details.selected).toEqual(
      ["F1", "F2", "F3", "F4"].map((task) => ({
        task,
        phase: "final",
        runOrdinal: 1,
        commandCount: 1,
        observedSha: sha,
      })),
    );
    expect(receipt.details.inputArtifactPaths).not.toContain(output);
    expect(
      receipt.details.inputArtifactPaths.every(
        (artifactPath: string) =>
          artifactPath === path.posix.normalize(artifactPath),
      ),
    ).toBe(true);
    assertFixtureReceipts(fixture.evidenceDirectory, [
      ...fixture.receiptPaths.values(),
    ]);
  });
});
