import {
  DATABASE_V2_BUNDLE_IDS,
  DATABASE_V2_SCOPE_ALPHA,
  createDatabaseV2TestBundle,
} from "../fixtures";
import type {
  DatabaseConnectorV2TestPageQuery,
  DatabaseConnectorV2TestScope,
  DatabaseConnectorV2TestSubject,
} from "../types";
import {
  createConnectedSubject,
  createScriptedContext,
  createScriptedPage,
  createScriptedSession,
  hasDefect,
  ScriptedConnectorError,
  type ScriptedHarnessDefect,
} from "./scriptedSupport";

const firstBundle = createDatabaseV2TestBundle(
  DATABASE_V2_BUNDLE_IDS.first,
  "production",
);
const secondBundle = createDatabaseV2TestBundle(
  DATABASE_V2_BUNDLE_IDS.second,
  "staging",
);
const firstRow = { value: firstBundle, revision: "revision:first" } as const;
const secondRow = { value: secondBundle, revision: "revision:second" } as const;

export function createHappyReadSubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  const openSession = async (scope: DatabaseConnectorV2TestScope) => {
    const acceptedEmptyPrincipal =
      scope.principalId.length === 0 &&
      hasDefect(context, "accept-empty-principal");
    if (scope.tenantId.length === 0 || scope.principalId.length === 0) {
      if (!acceptedEmptyPrincipal) {
        if (hasDefect(context, "invalid-scope-backend-io")) {
          context.backendOperations += 1;
        }
        throw new ScriptedConnectorError("INVALID_SCOPE");
      }
    }
    context.backendOperations += 1;
    const sameTenant = scope.tenantId === DATABASE_V2_SCOPE_ALPHA.tenantId;
    const visible = sameTenant || hasDefect(context, "cross-tenant-read");
    return createScriptedSession({
      get: async (id) =>
        visible && id === DATABASE_V2_BUNDLE_IDS.first ? firstRow : null,
      page: async () =>
        visible
          ? createScriptedPage([firstRow, secondRow], 2)
          : createScriptedPage([], 0),
      channels: async () => (visible ? ["production", "staging"] : []),
    });
  };
  return createConnectedSubject(context, openSession);
}

function cursorPage(query: DatabaseConnectorV2TestPageQuery) {
  if (query.cursor === undefined) {
    return createScriptedPage([firstRow], 3, "cursor:first");
  }
  if (query.limit === 1 && query.cursor.after === "cursor:first") {
    return createScriptedPage([secondRow], 3, "cursor:second");
  }
  throw new ScriptedConnectorError("INVALID_CURSOR");
}

export function createCursorSubject(
  defects: readonly ScriptedHarnessDefect[],
): DatabaseConnectorV2TestSubject {
  const context = createScriptedContext(defects);
  return createConnectedSubject(context, async (scope) =>
    createScriptedSession({
      page: async (query) => {
        const foreignPrincipal =
          scope.principalId !== DATABASE_V2_SCOPE_ALPHA.principalId;
        if (foreignPrincipal && !hasDefect(context, "accept-foreign-cursor")) {
          throw new ScriptedConnectorError("INVALID_CURSOR");
        }
        return cursorPage(query);
      },
    }),
  );
}
