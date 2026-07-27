import { readFileSync } from "node:fs";
import path from "node:path";

import { invariant, readJson, runCommand, sha256 } from "./driverSupport.mjs";
import {
  collectArtifactPaths,
  requireSelectedTasks,
  summarizeSelectedTasks,
  validateEvidenceDirectory,
} from "./evidenceEngine.mjs";

const FORBIDDEN_PATHS = [
  /^packages\/console\//,
  /^packages\/better-auth\//,
  /(?:^|\/)(?:nitro|template|auth)(?:\/|$)/,
];

export const runScopeMode = ({
  workspace,
  base,
  head,
  simulatePaths,
  fixture,
  prJson,
}) => {
  invariant(
    typeof base === "string" && typeof head === "string",
    "Scope mode requires --base and --head.",
  );
  const diff = runCommand(
    ["git", "diff", "--name-only", `${base}...${head}`],
    workspace,
  );
  invariant(diff.exitCode === 0, "Scope diff command failed.");
  const fixtureInput =
    fixture === undefined
      ? undefined
      : readJson(path.resolve(workspace, fixture));
  const paths = [
    ...diff.stdout.split("\n").filter(Boolean),
    ...simulatePaths,
    ...(fixtureInput?.paths ?? []),
  ];
  invariant(
    paths.every((changedPath) =>
      FORBIDDEN_PATHS.every((pattern) => !pattern.test(changedPath)),
    ),
    "Scope contains a forbidden simulated path.",
  );

  if (prJson !== undefined || fixtureInput?.pr !== undefined) {
    const pr = fixtureInput?.pr ?? readJson(path.resolve(workspace, prJson));
    const headSha = runCommand(
      ["git", "rev-parse", head],
      workspace,
    ).stdout.trim();
    invariant(
      pr.state === "OPEN" && pr.isDraft === false,
      "PR is not open and non-draft.",
    );
    invariant(pr.headRefOid === headSha, "PR head SHA does not match.");
    invariant(
      (pr.statusCheckRollup ?? []).every((check) =>
        ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion),
      ),
      "PR checks are incomplete or failed.",
    );
  }
  return { commands: [diff], details: { base, head, paths } };
};

const findApprovedPlanHash = (receipts, evidenceDirectory) => {
  for (const receipt of receipts) {
    if (String(receipt.task) !== "1") {
      continue;
    }
    for (const artifact of receipt.artifacts) {
      if (!artifact.path.endsWith("task-1-baseline.txt")) {
        continue;
      }
      const match = readFileSync(
        path.resolve(evidenceDirectory, artifact.path),
        "utf8",
      ).match(/^approved_plan_sha256=([0-9a-f]{64})$/m);
      if (match?.[1] !== undefined) {
        return match[1];
      }
    }
  }
  throw new TypeError("Todo 1 did not record APPROVED_PLAN_SHA256.");
};

export const runEvidenceMode = ({
  workspace,
  evidenceDirectory,
  finalSha,
  plan,
  prJson,
}) => {
  invariant(
    plan !== undefined && prJson !== undefined,
    "Evidence mode requires --plan and --pr-json.",
  );
  const validated = validateEvidenceDirectory({
    workspace,
    evidenceDirectory,
    finalSha,
  });
  const requiredTasks = [
    ...Array.from({ length: 25 }, (_, index) => String(index + 1)),
    "F1",
    "F2",
    "F3",
  ];
  requireSelectedTasks(validated.selected, requiredTasks);
  const approvedPlanHash = findApprovedPlanHash(
    validated.receipts,
    evidenceDirectory,
  );
  invariant(
    sha256(readFileSync(path.resolve(workspace, plan))) === approvedPlanHash,
    "Execution plan does not match Todo 1 APPROVED_PLAN_SHA256.",
  );
  const pr = readJson(path.resolve(workspace, prJson));
  invariant(
    pr.headRefOid === finalSha,
    "Evidence PR snapshot predates the final SHA.",
  );
  invariant(
    pr.state === "OPEN" && pr.isDraft === false,
    "Evidence PR snapshot is not open and non-draft.",
  );
  return {
    commands: [],
    details: {
      receiptCount: validated.receipts.length,
      approvedPlanHash,
      selectedGroupCount: validated.selected.size,
      historicalReceiptCount: 23,
      currentReceiptCount: 5,
      selected: summarizeSelectedTasks(validated.selected, requiredTasks),
      inputArtifactPaths: collectArtifactPaths(validated.records),
    },
  };
};

export const runCompletionMode = ({
  workspace,
  evidenceDirectory,
  finalSha,
  output,
}) => {
  const validated = validateEvidenceDirectory({
    workspace,
    evidenceDirectory,
    finalSha,
    forbiddenPath: output,
  });
  const requiredTasks = ["F1", "F2", "F3", "F4"];
  requireSelectedTasks(validated.selected, requiredTasks);
  return {
    commands: [],
    details: {
      selected: summarizeSelectedTasks(validated.selected, requiredTasks),
      receiptCount: validated.records.length,
      inputArtifactPaths: collectArtifactPaths(validated.records),
    },
  };
};
