#!/usr/bin/env node
import path from "node:path";

import {
  currentSha,
  parseArguments,
  writeReceipt,
} from "../packages/test-utils/src/storage/release/driverSupport.mjs";
import { runManualQaMode } from "../packages/test-utils/src/storage/release/manualQaMode.mjs";
import { runMatrixMode } from "../packages/test-utils/src/storage/release/matrixMode.mjs";
import { createReleaseSourceBinding } from "../packages/test-utils/src/storage/release/releaseSourceBinding.mjs";
import {
  runCompletionMode,
  runEvidenceMode,
  runScopeMode,
} from "../packages/test-utils/src/storage/release/verificationModes.mjs";

const workspace = process.cwd();
const options = parseArguments(process.argv.slice(2));
if (typeof options.mode !== "string" || typeof options.output !== "string") {
  throw new TypeError("Storage v2 verifier requires --mode and --output.");
}
const output = path.resolve(workspace, options.output);
const observedSha = currentSha(workspace);

try {
  let result;
  switch (options.mode) {
    case "matrix":
      result = runMatrixMode({
        workspace,
        fixture: options.fixture,
      });
      break;
    case "scope":
      result = runScopeMode({
        workspace,
        base: options.base,
        head: options.head,
        simulatePaths: options.simulatePaths,
        fixture: options.fixture,
        prJson: options["pr-json"],
      });
      break;
    case "evidence":
      result = runEvidenceMode({
        workspace,
        evidenceDirectory: path.resolve(workspace, options["evidence-dir"]),
        finalSha: options.sha,
        plan: options.plan,
        prJson: options["pr-json"],
      });
      break;
    case "manual-qa":
      result = runManualQaMode({ workspace, output });
      break;
    case "completion":
      result = runCompletionMode({
        workspace,
        evidenceDirectory: path.resolve(workspace, options["evidence-dir"]),
        finalSha: options.sha,
        output,
      });
      break;
    default:
      throw new TypeError(
        `Unsupported Storage v2 verifier mode: ${options.mode}`,
      );
  }
  writeReceipt({
    output,
    mode: options.mode,
    observedSha,
    verdict: "passed",
    commands: result.commands,
    details: {
      ...result.details,
      sourceBinding: createReleaseSourceBinding(workspace),
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const invariant =
    error instanceof Error && typeof error.code === "string"
      ? error.code
      : undefined;
  writeReceipt({
    output,
    mode: options.mode,
    observedSha,
    verdict: "failed",
    commands: [],
    details: {
      error: message,
      ...(invariant === undefined ? {} : { invariant }),
      sourceBinding: createReleaseSourceBinding(workspace),
    },
  });
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
