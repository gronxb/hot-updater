import { describe, it } from "vitest";

import { runDatabaseV2MalformedChangeSetScenario } from "./database-v2/inputScenario";
import { runDatabaseV2LifecycleScenario } from "./database-v2/lifecycleScenario";
import {
  runDatabaseV2CursorBindingScenario,
  runDatabaseV2HappyReadAndScopeScenario,
} from "./database-v2/readScenarios";
import {
  runDatabaseV2AtomicityScenario,
  runDatabaseV2ReplayScenario,
} from "./database-v2/receiptScenarios";
import {
  runDatabaseV2ConcurrentCommitScenario,
  runDatabaseV2UnknownRecoveryScenario,
} from "./database-v2/stateScenarios";
import type { DatabaseConnectorV2TestHarness } from "./database-v2/types";

export function setupDatabaseConnectorV2TestSuite(
  harness: DatabaseConnectorV2TestHarness,
): void {
  describe("database connector v2 structural conformance", () => {
    it("reads and lists tenant data while enforcing trusted asserted scope", async () => {
      await runDatabaseV2HappyReadAndScopeScenario(harness);
    });

    it("binds opaque cursors to principal and query identity", async () => {
      await runDatabaseV2CursorBindingScenario(harness);
    });

    it("applies every change atomically", async () => {
      await runDatabaseV2AtomicityScenario(harness);
    });

    it("rejects malformed change sets before backend I/O", async () => {
      await runDatabaseV2MalformedChangeSetScenario(harness);
    });

    it("replays receipts across sessions and separates principals", async () => {
      await runDatabaseV2ReplayScenario(harness);
    });

    it("rejects a concurrent commit before second backend I/O", async () => {
      await runDatabaseV2ConcurrentCommitScenario(harness);
    });

    it("fails closed and recovers only through identical replay", async () => {
      await runDatabaseV2UnknownRecoveryScenario(harness);
    });

    it("enforces connector, connection, and session lifecycle", async () => {
      await runDatabaseV2LifecycleScenario(harness);
    });
  });
}

export {
  DatabaseConnectorV2ConformanceViolation,
  type DatabaseConnectorV2ConformanceCheck,
} from "./database-v2/assertions";
export type {
  DatabaseConnectorV2TestChange,
  DatabaseConnectorV2TestChangeSet,
  DatabaseConnectorV2TestConnection,
  DatabaseConnectorV2TestConnector,
  DatabaseConnectorV2TestContext,
  DatabaseConnectorV2TestFaults,
  DatabaseConnectorV2TestHarness,
  DatabaseConnectorV2TestInstrumentation,
  DatabaseConnectorV2TestPage,
  DatabaseConnectorV2TestPageQuery,
  DatabaseConnectorV2TestReceipt,
  DatabaseConnectorV2TestRepository,
  DatabaseConnectorV2TestScenario,
  DatabaseConnectorV2TestScope,
  DatabaseConnectorV2TestSession,
  DatabaseConnectorV2TestSubject,
  DatabaseConnectorV2TestVersionedBundle,
  DatabaseConnectorV2TestWhere,
} from "./database-v2/types";
