import {
  DATABASE_V2_BUNDLE_IDS,
  createDatabaseV2TestBundle,
} from "../fixtures";
import type { DatabaseConnectorV2TestSubject } from "../types";
import {
  committedReceipt,
  createConnectedSubject,
  createScriptedContext,
  createScriptedSession,
  hasDefect,
  ScriptedConnectorError,
  unknownReceipt,
  type ScriptedHarnessDefect,
} from "./scriptedSupport";

const firstBundle = createDatabaseV2TestBundle(
  DATABASE_V2_BUNDLE_IDS.first,
  "production",
);
const durableBundle = createDatabaseV2TestBundle(
  DATABASE_V2_BUNDLE_IDS.second,
  "durable",
);
export function createConcurrentSubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  let applyCalls = 0;
  return createConnectedSubject(context, async () =>
    createScriptedSession({
      apply: async (changeSet) => {
        applyCalls += 1;
        if (applyCalls === 2) {
          if (hasDefect(context, "concurrent-backend-io")) {
            context.backendCommits += 1;
          }
          throw new ScriptedConnectorError("CONCURRENT_COMMIT");
        }
        context.backendCommits += 1;
        context.heldEntered.resolve();
        await context.heldRelease.promise;
        return committedReceipt(changeSet);
      },
    }),
  );
}

export function createUnknownSubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  let applyCalls = 0;
  let getCalls = 0;
  return createConnectedSubject(context, async () =>
    createScriptedSession({
      get: async () => {
        getCalls += 1;
        if (getCalls <= 2 && !hasDefect(context, "allow-poisoned-read")) {
          throw new ScriptedConnectorError("SESSION_POISONED");
        }
        if (getCalls === 3) {
          return { value: firstBundle, revision: "revision:first" };
        }
        if (getCalls === 4) {
          return { value: durableBundle, revision: "revision:durable" };
        }
        return null;
      },
      apply: async (changeSet) => {
        applyCalls += 1;
        context.backendCommits += 1;
        if (applyCalls === 2) {
          throw new ScriptedConnectorError("SESSION_POISONED");
        }
        if (applyCalls === 1 || applyCalls === 3 || applyCalls === 5) {
          return unknownReceipt(changeSet);
        }
        if (applyCalls === 6) {
          const committed = committedReceipt(changeSet);
          return { ...committed, outcome: "replayed" };
        }
        return committedReceipt(changeSet);
      },
    }),
  );
}
