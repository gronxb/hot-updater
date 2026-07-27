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
const SUCCESSFUL_CHECK_RUN_CONCLUSIONS = ["SUCCESS", "NEUTRAL", "SKIPPED"];

const parseStatusCheck = (check) => {
  if (typeof check !== "object" || check === null) {
    return undefined;
  }
  const hasConclusion = Object.hasOwn(check, "conclusion");
  const hasState = Object.hasOwn(check, "state");
  const isCheckRun =
    check.__typename === "CheckRun" && hasConclusion && !hasState;
  if (isCheckRun) {
    return typeof check.conclusion === "string" || check.conclusion === null
      ? { kind: "check-run", conclusion: check.conclusion }
      : undefined;
  }
  const isStatusContext =
    check.__typename === "StatusContext" && hasState && !hasConclusion;
  if (isStatusContext) {
    return typeof check.state === "string"
      ? { kind: "status-context", state: check.state }
      : undefined;
  }
  return undefined;
};

const isSuccessfulStatusCheck = (check) => {
  const parsed = parseStatusCheck(check);
  if (parsed?.kind === "check-run") {
    return SUCCESSFUL_CHECK_RUN_CONCLUSIONS.includes(parsed.conclusion);
  }
  return parsed?.kind === "status-context" && parsed.state === "SUCCESS";
};

const readScopeFixture = (workspace, fixture) => {
  const fixtureInput = readJson(path.resolve(workspace, fixture));
  invariant(
    fixtureInput.schema === "hot-updater.storage-v2-scope-fixture/v1",
    "Scope fixture schema is invalid.",
  );
  invariant(
    fixtureInput.paths === undefined ||
      (Array.isArray(fixtureInput.paths) &&
        fixtureInput.paths.every((value) => typeof value === "string")),
    "Scope fixture paths are invalid.",
  );
  invariant(
    fixtureInput.openPrCount === undefined ||
      (Number.isInteger(fixtureInput.openPrCount) &&
        fixtureInput.openPrCount >= 0),
    "Scope fixture open PR count is invalid.",
  );
  invariant(
    fixtureInput.remoteBranch === undefined ||
      (typeof fixtureInput.remoteBranch === "object" &&
        fixtureInput.remoteBranch !== null &&
        typeof fixtureInput.remoteBranch.isAncestor === "boolean"),
    "Scope fixture remote branch is invalid.",
  );
  invariant(
    fixtureInput.pr === undefined ||
      (typeof fixtureInput.pr === "object" &&
        fixtureInput.pr !== null &&
        typeof fixtureInput.pr.state === "string" &&
        typeof fixtureInput.pr.isDraft === "boolean" &&
        typeof fixtureInput.pr.baseRefName === "string" &&
        typeof fixtureInput.pr.headRefOid === "string" &&
        Array.isArray(fixtureInput.pr.statusCheckRollup) &&
        fixtureInput.pr.statusCheckRollup.every(
          (check) => parseStatusCheck(check) !== undefined,
        )),
    "Scope fixture PR is invalid.",
  );
  return fixtureInput;
};

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
    fixture === undefined ? undefined : readScopeFixture(workspace, fixture);
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
  invariant(
    fixtureInput?.remoteBranch?.isAncestor !== false,
    "Remote storage branch is not an ancestor of local HEAD.",
  );
  invariant(
    fixtureInput?.openPrCount === undefined || fixtureInput.openPrCount <= 1,
    "More than one open PR exists for the storage branch.",
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
    invariant(
      pr.baseRefName === "codex/server-plugin-kernel",
      "PR base branch does not match.",
    );
    const prHeadSha =
      fixtureInput?.pr !== undefined && pr.headRefOid === "$HEAD"
        ? headSha
        : pr.headRefOid;
    invariant(prHeadSha === headSha, "PR head SHA does not match.");
    invariant(
      Array.isArray(pr.statusCheckRollup) &&
        pr.statusCheckRollup.length > 0 &&
        pr.statusCheckRollup.every(isSuccessfulStatusCheck),
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
