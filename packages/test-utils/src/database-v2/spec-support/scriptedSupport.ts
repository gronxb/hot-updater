import type {
  DatabaseConnectorV2TestChangeSet,
  DatabaseConnectorV2TestConnection,
  DatabaseConnectorV2TestPage,
  DatabaseConnectorV2TestReceipt,
  DatabaseConnectorV2TestRepository,
  DatabaseConnectorV2TestScope,
  DatabaseConnectorV2TestSession,
  DatabaseConnectorV2TestSubject,
  DatabaseConnectorV2TestVersionedBundle,
} from "../types";

export type ScriptedHarnessDefect =
  | "accept-empty-principal"
  | "accept-foreign-cursor"
  | "allow-poisoned-read"
  | "allow-use-after-close"
  | "concurrent-backend-io"
  | "cross-tenant-read"
  | "invalid-scope-backend-io"
  | "leave-child-sessions-open"
  | "partial-write"
  | "reapply-replay"
  | "resolve-connection-close-early"
  | "replace-receipt-on-collision";

export class ScriptedConnectorError extends Error {
  override readonly name = "ScriptedConnectorError";

  constructor(readonly code: string) {
    super(code);
  }
}

interface ScriptedDeferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export interface ScriptedContext {
  readonly defects: readonly ScriptedHarnessDefect[];
  backendOperations: number;
  backendCommits: number;
  domainMutations: number;
  readonly heldEntered: ScriptedDeferred;
  readonly heldRelease: ScriptedDeferred;
}

function createDeferred(): ScriptedDeferred {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise(),
  };
}

export function createScriptedContext(
  defects: readonly ScriptedHarnessDefect[],
): ScriptedContext {
  return {
    defects,
    backendOperations: 0,
    backendCommits: 0,
    domainMutations: 0,
    heldEntered: createDeferred(),
    heldRelease: createDeferred(),
  };
}

export function hasDefect(
  context: ScriptedContext,
  defect: ScriptedHarnessDefect,
): boolean {
  return context.defects.includes(defect);
}

export function createScriptedSubject(
  context: ScriptedContext,
  connect: () => DatabaseConnectorV2TestConnection,
): DatabaseConnectorV2TestSubject {
  return {
    connector: {
      connect,
    },
    instrumentation: {
      backendOperationAttempts: () => context.backendOperations,
      backendCommitAttempts: () => context.backendCommits,
      domainMutationCount: () => context.domainMutations,
    },
    faults: {
      holdNextCommit: () => undefined,
      waitForHeldCommit: () => context.heldEntered.promise,
      releaseHeldCommit: () => context.heldRelease.resolve(),
      interruptNextCommit: () => undefined,
    },
  };
}

export function createScriptedConnection(
  openSession: (
    scope: DatabaseConnectorV2TestScope,
  ) => Promise<DatabaseConnectorV2TestSession>,
  close: () => Promise<void> = async () => undefined,
): DatabaseConnectorV2TestConnection {
  return { openSession, close };
}

export interface ScriptedSession {
  readonly get?: DatabaseConnectorV2TestRepository["get"];
  readonly page?: DatabaseConnectorV2TestRepository["page"];
  readonly channels?: DatabaseConnectorV2TestRepository["channels"];
  readonly apply?: DatabaseConnectorV2TestSession["applyChangeSet"];
  readonly close?: DatabaseConnectorV2TestSession["close"];
}

export function createScriptedSession(
  script: ScriptedSession,
): DatabaseConnectorV2TestSession {
  return {
    bundles: {
      get: script.get ?? (async () => null),
      page: script.page ?? (async () => createScriptedPage([], 0)),
      channels: script.channels ?? (async () => []),
    },
    applyChangeSet:
      script.apply ?? (async (changeSet) => committedReceipt(changeSet)),
    close: script.close ?? (async () => undefined),
  };
}

export function createConnectedSubject(
  context: ScriptedContext,
  openSession: DatabaseConnectorV2TestConnection["openSession"],
  close?: DatabaseConnectorV2TestConnection["close"],
): DatabaseConnectorV2TestSubject {
  return createScriptedSubject(context, () =>
    createScriptedConnection(openSession, close),
  );
}

export function createScriptedPage(
  data: readonly DatabaseConnectorV2TestVersionedBundle[],
  total: number,
  nextCursor: string | null = null,
): DatabaseConnectorV2TestPage {
  return {
    data,
    pagination: {
      total,
      hasNextPage: nextCursor !== null,
      hasPreviousPage: false,
      nextCursor,
      previousCursor: null,
    },
  };
}

type DurableReceipt = Extract<
  DatabaseConnectorV2TestReceipt,
  { readonly outcome: "committed" | "replayed" }
>;

export function committedReceipt(
  changeSet: DatabaseConnectorV2TestChangeSet,
  scopeId = "scope:tenant-alpha:principal-alpha",
): DurableReceipt {
  const firstChange = changeSet.changes[0];
  const bundleId =
    firstChange?.type === "put" ? firstChange.value.id : firstChange?.id;
  return {
    changeSetId: changeSet.id,
    scopeId,
    canonicalPayloadHash: `payload:${changeSet.id}`,
    outcome: "committed",
    revisions:
      bundleId === undefined ? {} : { [bundleId]: "revision:scripted" },
  };
}

export function rejectedReceipt(
  changeSetId: string,
): DatabaseConnectorV2TestReceipt {
  return {
    changeSetId,
    scopeId: "scope:tenant-alpha:principal-alpha",
    canonicalPayloadHash: "payload:rejected",
    outcome: "rejected",
    reason: "conflict",
  };
}

export function unknownReceipt(
  changeSet: DatabaseConnectorV2TestChangeSet,
): DatabaseConnectorV2TestReceipt {
  return {
    changeSetId: changeSet.id,
    scopeId: "scope:tenant-alpha:principal-alpha",
    canonicalPayloadHash: `payload:${changeSet.id}`,
    outcome: "unknown",
    reason: "transport-unknown",
    sessionState: "poisoned",
    retry: "identical-scope-id-and-payload-only",
  };
}
