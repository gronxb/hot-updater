import type {
  DatabaseConnectorV2TestHarness,
  DatabaseConnectorV2TestScenario,
  DatabaseConnectorV2TestSubject,
} from "../types";
import {
  createAtomicSubject,
  createMalformedSubject,
  createReplaySubject,
} from "./scriptedCommitSubjects";
import { createLifecycleSubject } from "./scriptedLifecycleSubjects";
import {
  createCursorSubject,
  createHappyReadSubject,
} from "./scriptedReadSubjects";
import {
  createConcurrentSubject,
  createUnknownSubject,
} from "./scriptedStateSubjects";
import {
  ScriptedConnectorError,
  type ScriptedHarnessDefect,
} from "./scriptedSupport";

function createSubject(
  scenario: DatabaseConnectorV2TestScenario,
  defects: readonly ScriptedHarnessDefect[],
  lifecycleOrdinal: number,
): DatabaseConnectorV2TestSubject {
  switch (scenario) {
    case "atomicity":
      return createAtomicSubject(defects);
    case "concurrent-commit":
      return createConcurrentSubject(defects);
    case "cursor-binding":
      return createCursorSubject(defects);
    case "happy-read-and-scope":
      return createHappyReadSubject(defects);
    case "lifecycle":
      return createLifecycleSubject(lifecycleOrdinal, defects);
    case "malformed-change-set":
      return createMalformedSubject();
    case "receipt-replay":
      return createReplaySubject(defects);
    case "unknown-recovery":
      return createUnknownSubject(defects);
    default:
      throw new ScriptedConnectorError(
        `UNSCRIPTED_SCENARIO:${String(scenario)}`,
      );
  }
}

export function createScriptedDatabaseConnectorV2Harness(
  defects: readonly ScriptedHarnessDefect[] = [],
): DatabaseConnectorV2TestHarness {
  let lifecycleSubjects = 0;
  return {
    createSubject: (scenario) => {
      if (scenario === "lifecycle") {
        lifecycleSubjects += 1;
      }
      return createSubject(scenario, defects, lifecycleSubjects);
    },
  };
}
