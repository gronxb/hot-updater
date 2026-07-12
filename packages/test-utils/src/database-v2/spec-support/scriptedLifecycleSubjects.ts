import {
  DATABASE_V2_BUNDLE_IDS,
  createDatabaseV2TestBundle,
} from "../fixtures";
import type {
  DatabaseConnectorV2TestConnection,
  DatabaseConnectorV2TestSubject,
} from "../types";
import {
  committedReceipt,
  createScriptedConnection,
  createScriptedContext,
  createScriptedSession,
  createScriptedSubject,
  hasDefect,
  ScriptedConnectorError,
  type ScriptedContext,
  type ScriptedHarnessDefect,
  type ScriptedSession,
} from "./scriptedSupport";

const bundle = createDatabaseV2TestBundle(
  DATABASE_V2_BUNDLE_IDS.first,
  "production",
);
const row = { value: bundle, revision: "revision:first" } as const;
const retainedScript: ScriptedSession = {
  get: async () => row,
};

function closedScript(allowCalls: boolean): ScriptedSession {
  const rejectClosed = () => {
    if (!allowCalls) {
      throw new ScriptedConnectorError("SESSION_CLOSED");
    }
  };
  return {
    get: async () => {
      rejectClosed();
      return null;
    },
    channels: async () => {
      rejectClosed();
      return [];
    },
  };
}

function createPrimaryConnection(
  context: ScriptedContext,
): DatabaseConnectorV2TestConnection {
  let openCalls = 0;
  return createScriptedConnection(async () => {
    openCalls += 1;
    if (openCalls > 1) {
      throw new ScriptedConnectorError("CONNECTION_CLOSED");
    }
    const script = closedScript(hasDefect(context, "allow-use-after-close"));
    return createScriptedSession(script);
  });
}

function createPrimarySubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  let connectCalls = 0;
  return createScriptedSubject(context, () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      return createPrimaryConnection(context);
    }
    return createScriptedConnection(async () =>
      createScriptedSession(retainedScript),
    );
  });
}

function createIdleSubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  const script = closedScript(hasDefect(context, "leave-child-sessions-open"));
  return createScriptedSubject(context, () =>
    createScriptedConnection(async () => createScriptedSession(script)),
  );
}

function createRaceSubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  const session = createScriptedSession({
    ...closedScript(false),
    apply: async (changeSet) => {
      context.backendCommits += 1;
      context.heldEntered.resolve();
      await context.heldRelease.promise;
      return committedReceipt(changeSet, "scope:race");
    },
  });
  return createScriptedSubject(context, () =>
    createScriptedConnection(
      async () => session,
      () => {
        if (hasDefect(context, "resolve-connection-close-early")) {
          return Promise.resolve();
        }
        return context.heldRelease.promise;
      },
    ),
  );
}

export function createLifecycleSubject(
  ordinal: number,
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  switch (ordinal) {
    case 1:
      return createPrimarySubject(defects);
    case 2:
      return createIdleSubject(defects);
    case 3:
      return createRaceSubject(defects);
    default:
      throw new ScriptedConnectorError("UNSCRIPTED_LIFECYCLE_SUBJECT");
  }
}
