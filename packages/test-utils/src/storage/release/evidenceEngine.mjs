import { runCommand } from "./driverSupport.mjs";
import { evidenceInvariant } from "./evidenceInvariant.mjs";
import {
  readAndSelectEvidence,
  selectedKey,
} from "./evidenceReceiptValidation.mjs";

const HISTORICAL_TASK_PATTERN = /^(?:[1-9]|1[0-9]|2[0-3])$/;
const CURRENT_TASKS = ["24", "25", "F1", "F2", "F3", "F4"];

const isAncestor = (workspace, ancestorSha, finalSha) =>
  runCommand(
    ["git", "merge-base", "--is-ancestor", ancestorSha, finalSha],
    workspace,
  ).exitCode === 0;

const validateHistoricalEpoch = (records, workspace, finalSha) => {
  for (const { receipt } of records) {
    const task = String(receipt.task);
    if (!HISTORICAL_TASK_PATTERN.test(task)) {
      continue;
    }
    evidenceInvariant(
      isAncestor(workspace, receipt.observedSha, finalSha),
      `historical-crossed-epoch:${task}`,
      `Historical receipt ${task} crossed epochs.`,
    );
  }
};

const validateCurrentEpoch = (records, selected, workspace, finalSha) => {
  for (const task of CURRENT_TASKS) {
    const current = selected.get(selectedKey(task));
    if (current === undefined) {
      continue;
    }
    const observedShas = new Set(
      current.map(({ receipt }) => receipt.observedSha),
    );
    evidenceInvariant(
      observedShas.size === 1,
      `current-sha-conflict:${task}`,
      `Current final receipt ${task} has conflicting SHAs.`,
    );
    const observedSha = current[0]?.receipt.observedSha;
    if (observedSha !== finalSha) {
      evidenceInvariant(
        observedSha !== undefined &&
          !isAncestor(workspace, observedSha, finalSha),
        `missing-current-supersession:${task}`,
        `Current final receipt ${task} is missing an exact-SHA supersession.`,
      );
      evidenceInvariant(
        false,
        `current-final-stale:${task}`,
        `Current final receipt ${task} has a stale SHA.`,
      );
    }
    const currentOrdinal = current[0]?.receipt.runOrdinal;
    for (const { receipt } of records) {
      if (
        String(receipt.task) !== task ||
        receipt.phase !== "final" ||
        receipt.runOrdinal === currentOrdinal
      ) {
        continue;
      }
      evidenceInvariant(
        isAncestor(workspace, receipt.observedSha, finalSha),
        `superseded-crossed-epoch:${task}:${receipt.runOrdinal}`,
        `Superseded receipt ${task}/run-${receipt.runOrdinal} crossed epochs.`,
      );
    }
  }
};

export const validateEvidenceDirectory = ({
  workspace,
  evidenceDirectory,
  finalSha,
  forbiddenPath,
}) => {
  const validated = readAndSelectEvidence({
    evidenceDirectory,
    forbiddenPath,
  });
  validateHistoricalEpoch(validated.records, workspace, finalSha);
  validateCurrentEpoch(
    validated.records,
    validated.selected,
    workspace,
    finalSha,
  );
  return {
    ...validated,
    receipts: validated.records.map(({ receipt }) => receipt),
  };
};

export const requireSelectedTasks = (selected, tasks) => {
  for (const task of tasks) {
    evidenceInvariant(
      selected.has(selectedKey(task)),
      `missing-current-final:${task}`,
      `Current final receipt is missing for ${task}.`,
    );
  }
};

export const summarizeSelectedTasks = (selected, tasks) => {
  requireSelectedTasks(selected, tasks);
  return tasks.map((task) => {
    const records = selected.get(selectedKey(task));
    const receipt = records?.[0]?.receipt;
    evidenceInvariant(
      receipt !== undefined,
      `missing-current-final:${task}`,
      `Current final receipt is missing for ${task}.`,
    );
    return {
      task,
      phase: receipt.phase,
      runOrdinal: receipt.runOrdinal,
      commandCount: receipt.commandCount,
      observedSha: receipt.observedSha,
    };
  });
};

export const collectArtifactPaths = (records) =>
  [
    ...new Set(
      records.flatMap(({ receipt }) =>
        receipt.artifacts.map(({ path }) => path),
      ),
    ),
  ].sort();
