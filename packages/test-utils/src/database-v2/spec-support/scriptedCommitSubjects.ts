import {
  DATABASE_V2_BUNDLE_IDS,
  DATABASE_V2_SCOPE_BETA,
  createDatabaseV2TestBundle,
} from "../fixtures";
import type { DatabaseConnectorV2TestSubject } from "../types";
import {
  committedReceipt,
  createConnectedSubject,
  createScriptedContext,
  createScriptedSession,
  hasDefect,
  rejectedReceipt,
  ScriptedConnectorError,
  type ScriptedHarnessDefect,
} from "./scriptedSupport";

const firstBundle = createDatabaseV2TestBundle(
  DATABASE_V2_BUNDLE_IDS.first,
  "production",
);
const firstRow = { value: firstBundle, revision: "revision:first" } as const;
export function createAtomicSubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  return createConnectedSubject(context, async () =>
    createScriptedSession({
      get: async (id) =>
        hasDefect(context, "partial-write") &&
        id === DATABASE_V2_BUNDLE_IDS.first
          ? firstRow
          : null,
      apply: async (changeSet) => {
        context.backendCommits += 1;
        if (hasDefect(context, "partial-write")) {
          context.domainMutations = 1;
        }
        return rejectedReceipt(changeSet.id);
      },
    }),
  );
}

export function createMalformedSubject(): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext([]);
  return createConnectedSubject(context, async () =>
    createScriptedSession({
      apply: async () => {
        throw new ScriptedConnectorError("INVALID_CHANGE_SET");
      },
    }),
  );
}

export function createReplaySubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  let applyCalls = 0;
  const revisions = {
    [DATABASE_V2_BUNDLE_IDS.first]: "revision:first",
  };
  return createConnectedSubject(context, async (scope) =>
    createScriptedSession({
      apply: async (changeSet) => {
        applyCalls += 1;
        context.backendCommits += 1;
        if (applyCalls === 1) {
          context.domainMutations = 1;
          return { ...committedReceipt(changeSet), revisions };
        }
        if (applyCalls === 2 && hasDefect(context, "reapply-replay")) {
          context.domainMutations += 1;
        }
        if (applyCalls === 4) {
          return rejectedReceipt(changeSet.id);
        }
        if (
          applyCalls === 5 &&
          hasDefect(context, "replace-receipt-on-collision")
        ) {
          return rejectedReceipt(changeSet.id);
        }
        if (scope.principalId === DATABASE_V2_SCOPE_BETA.principalId) {
          context.domainMutations += 1;
          return {
            ...committedReceipt(changeSet, "scope:tenant-alpha:principal-beta"),
            revisions: {
              [DATABASE_V2_BUNDLE_IDS.second]: "revision:second",
            },
          };
        }
        return {
          ...committedReceipt(changeSet),
          outcome: "replayed",
          revisions,
        };
      },
    }),
  );
}
