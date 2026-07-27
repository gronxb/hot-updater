import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type FixtureReceipt = Readonly<{
  schema: string;
  task: string;
  phase: "final";
  observedSha: string;
  runOrdinal: number;
  commandOrdinal: number;
  commandCount: number;
  argv: readonly string[];
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
  artifacts: readonly Readonly<{ path: string; sha256: string }>[];
}>;

export type EvidenceFixture = Readonly<{
  evidenceDirectory: string;
  planPath: string;
  receipts: ReadonlyMap<string, FixtureReceipt>;
  receiptPaths: ReadonlyMap<string, string>;
  artifactPaths: ReadonlyMap<string, string>;
}>;

const fixtureDirectory = path.resolve(import.meta.dirname, "fixtures");
const defaultPlanPath = path.join(fixtureDirectory, "storage-v2-plan.md");

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const resolvePlanPath = (workspace: string, planPath?: string): string => {
  if (planPath !== undefined) {
    return path.resolve(workspace, planPath);
  }
  const relativePlanPath = path.relative(fixtureDirectory, defaultPlanPath);
  if (
    relativePlanPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePlanPath)
  ) {
    throw new TypeError(
      "Default evidence plan must stay inside committed fixtures.",
    );
  }
  return defaultPlanPath;
};

export const writeFixtureReceipt = (
  receiptPath: string,
  receipt: FixtureReceipt,
): void => {
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
};

export const createEvidenceFixture = (
  root: string,
  workspace: string,
  finalSha: string,
  includeF4: boolean,
  planPath?: string,
): EvidenceFixture => {
  const evidenceDirectory = path.join(root, "evidence");
  const resolvedPlanPath = resolvePlanPath(workspace, planPath);
  const tasks = [
    ...Array.from({ length: 25 }, (_, index) => String(index + 1)),
    "F1",
    "F2",
    "F3",
    ...(includeF4 ? ["F4"] : []),
  ];
  const receipts = new Map<string, FixtureReceipt>();
  const receiptPaths = new Map<string, string>();
  const artifactPaths = new Map<string, string>();
  const planHash = sha256(readFileSync(resolvedPlanPath));

  for (const task of tasks) {
    const relativeArtifact =
      task === "1"
        ? "artifacts/1/final/run-1/task-1-baseline.txt"
        : `artifacts/${task}/final/run-1/output.txt`;
    const artifactPath = path.join(evidenceDirectory, relativeArtifact);
    const artifactContent =
      task === "1"
        ? `approved_plan_sha256=${planHash}\n`
        : `task=${task}\nsha=${finalSha}\n`;
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, artifactContent);
    const receipt: FixtureReceipt = {
      schema: "hot-updater.storage-v2-evidence/v1",
      task,
      phase: "final",
      observedSha: finalSha,
      runOrdinal: 1,
      commandOrdinal: 1,
      commandCount: 1,
      argv: ["fixture", task],
      exitCode: 0,
      stdoutSha256: sha256(""),
      stderrSha256: sha256(""),
      artifacts: [{ path: relativeArtifact, sha256: sha256(artifactContent) }],
    };
    const receiptPath = path.join(
      evidenceDirectory,
      `receipts/${task}/final/run-1/command-1.json`,
    );
    writeFixtureReceipt(receiptPath, receipt);
    receipts.set(task, receipt);
    receiptPaths.set(task, receiptPath);
    artifactPaths.set(task, artifactPath);
  }
  return {
    evidenceDirectory,
    planPath: resolvedPlanPath,
    receipts,
    receiptPaths,
    artifactPaths,
  };
};
