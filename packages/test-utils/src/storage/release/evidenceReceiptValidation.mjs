import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { readJson } from "./driverSupport.mjs";
import { validateArtifacts } from "./evidenceArtifactValidation.mjs";
import { evidenceInvariant } from "./evidenceInvariant.mjs";

const RECEIPT_SCHEMA = "hot-updater.storage-v2-evidence/v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RECEIPT_PATH_PATTERN =
  /^receipts\/([^/]+)\/(red|green|final)\/run-([1-9][0-9]*)\/command-([1-9][0-9]*)\.json$/;

const findJsonFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files.sort();
};

const groupKey = (receipt) => `${String(receipt.task)}\u0000${receipt.phase}`;

const validateReceiptShape = (receipt, evidenceDirectory, forbiddenPath) => {
  evidenceInvariant(
    receipt.schema === RECEIPT_SCHEMA,
    "receipt-schema",
    "Receipt schema is invalid.",
  );
  evidenceInvariant(
    ["red", "green", "final"].includes(receipt.phase),
    "receipt-phase",
    "Receipt phase is invalid.",
  );
  evidenceInvariant(
    SHA_PATTERN.test(receipt.observedSha),
    "receipt-sha",
    "Receipt SHA is invalid.",
  );
  for (const field of ["runOrdinal", "commandOrdinal", "commandCount"]) {
    evidenceInvariant(
      Number.isSafeInteger(receipt[field]) && receipt[field] > 0,
      `receipt-${field}`,
      `Receipt ${field} is invalid.`,
    );
  }
  evidenceInvariant(
    Array.isArray(receipt.argv) &&
      receipt.argv.every((item) => typeof item === "string"),
    "receipt-argv",
    "Receipt argv is invalid.",
  );
  evidenceInvariant(
    Number.isInteger(receipt.exitCode),
    "receipt-exit-code",
    "Receipt exitCode is invalid.",
  );
  for (const field of ["stdoutSha256", "stderrSha256"]) {
    evidenceInvariant(
      /^[0-9a-f]{64}$/.test(receipt[field]),
      `receipt-${field}`,
      `Receipt ${field} is invalid.`,
    );
  }
  validateArtifacts(receipt, evidenceDirectory, forbiddenPath);
};

const parseReceiptRecord = (receiptPath, evidenceDirectory, forbiddenPath) => {
  const relativePath = path
    .relative(evidenceDirectory, receiptPath)
    .split(path.sep)
    .join("/");
  const match = relativePath.match(RECEIPT_PATH_PATTERN);
  evidenceInvariant(
    match !== null,
    `receipt-path:${relativePath}`,
    `Receipt path is invalid: ${relativePath}`,
  );
  const receipt = readJson(receiptPath);
  validateReceiptShape(receipt, evidenceDirectory, forbiddenPath);
  return {
    receipt,
    relativePath,
    pathTask: match[1],
    pathPhase: match[2],
    pathRunOrdinal: Number(match[3]),
    pathCommandOrdinal: Number(match[4]),
  };
};

const validateRun = (task, phase, runOrdinal, records) => {
  const counts = new Set(records.map(({ receipt }) => receipt.commandCount));
  evidenceInvariant(
    counts.size === 1,
    `command-count-conflict:${task}:${phase}:${runOrdinal}`,
    `Receipt commandCount conflicts for ${task}/${phase}/run-${runOrdinal}.`,
  );
  const count = records[0]?.receipt.commandCount;
  const ordinals = records
    .map(({ receipt }) => receipt.commandOrdinal)
    .sort((left, right) => left - right);
  evidenceInvariant(
    ordinals.every((ordinal, index) => ordinal <= index + 1),
    `gapped-command-ordinal:${task}:${phase}:${runOrdinal}`,
    `Receipt command ordinals are gapped for ${task}/${phase}/run-${runOrdinal}.`,
  );
  evidenceInvariant(
    count !== undefined &&
      records.length === count &&
      ordinals.every((ordinal, index) => ordinal === index + 1),
    `incomplete-command-set:${task}:${phase}:${runOrdinal}`,
    `Receipt command set is incomplete for ${task}/${phase}/run-${runOrdinal}.`,
  );
};

export const readAndSelectEvidence = ({ evidenceDirectory, forbiddenPath }) => {
  const receiptRoot = path.join(evidenceDirectory, "receipts");
  const receiptFiles = existsSync(receiptRoot)
    ? findJsonFiles(receiptRoot)
    : [];
  evidenceInvariant(
    receiptFiles.length > 0,
    "receipt-set-empty",
    "No evidence receipts were found.",
  );
  const records = receiptFiles.map((receiptPath) =>
    parseReceiptRecord(receiptPath, evidenceDirectory, forbiddenPath),
  );
  const groups = new Map();
  for (const record of records) {
    const { receipt } = record;
    const task = String(receipt.task);
    const key = groupKey(receipt);
    const group = groups.get(key) ?? [];
    const duplicateRun = group.find(
      (candidate) =>
        candidate.receipt.runOrdinal === receipt.runOrdinal &&
        candidate.pathRunOrdinal !== record.pathRunOrdinal,
    );
    evidenceInvariant(
      duplicateRun === undefined,
      `duplicate-run-ordinal:${task}:${receipt.phase}:${receipt.runOrdinal}`,
      `Receipt run ordinal is duplicated for ${task}/${receipt.phase}/run-${receipt.runOrdinal}.`,
    );
    const duplicateCommand = group.find(
      (candidate) =>
        candidate.receipt.runOrdinal === receipt.runOrdinal &&
        candidate.receipt.commandOrdinal === receipt.commandOrdinal,
    );
    evidenceInvariant(
      duplicateCommand === undefined,
      `duplicate-command-ordinal:${task}:${receipt.phase}:${receipt.runOrdinal}:${receipt.commandOrdinal}`,
      `Receipt command ordinal is duplicated for ${task}/${receipt.phase}/run-${receipt.runOrdinal}.`,
    );
    group.push(record);
    groups.set(key, group);
  }

  const selected = new Map();
  for (const [key, group] of groups) {
    const first = group[0];
    evidenceInvariant(
      first !== undefined,
      "receipt-group-empty",
      "Empty group.",
    );
    const task = String(first.receipt.task);
    const phase = first.receipt.phase;
    for (const record of group) {
      evidenceInvariant(
        record.pathTask === task &&
          record.pathPhase === phase &&
          record.pathRunOrdinal === record.receipt.runOrdinal &&
          record.pathCommandOrdinal === record.receipt.commandOrdinal,
        `receipt-path-identity:${record.relativePath}`,
        `Receipt path does not match its identity: ${record.relativePath}`,
      );
    }
    const runOrdinals = [
      ...new Set(group.map(({ receipt }) => receipt.runOrdinal)),
    ].sort((left, right) => left - right);
    evidenceInvariant(
      runOrdinals.every((ordinal, index) => ordinal === index + 1),
      `gapped-run-ordinal:${task}:${phase}`,
      `Receipt run ordinals are gapped for ${task}/${phase}.`,
    );
    for (const runOrdinal of runOrdinals) {
      validateRun(
        task,
        phase,
        runOrdinal,
        group.filter(({ receipt }) => receipt.runOrdinal === runOrdinal),
      );
    }
    const highest = runOrdinals.at(-1);
    evidenceInvariant(
      highest !== undefined,
      `receipt-group-empty:${task}:${phase}`,
      `Receipt group ${task}/${phase} is empty.`,
    );
    selected.set(
      key,
      group.filter(({ receipt }) => receipt.runOrdinal === highest),
    );
  }
  return { records, selected };
};

export const selectedKey = (task, phase = "final") => `${task}\u0000${phase}`;
