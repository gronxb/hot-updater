type DiagnosticReply<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

type DiagnosticsModule = {
  installRuntimeJournalFixture(
    options: { readonly mode: RuntimeJournalFixtureMode },
    callback: (
      reply: DiagnosticReply<{ mode: RuntimeJournalFixtureMode }>,
    ) => void,
  ): void;
  appendRuntimeJournalFixtureEvent(
    callback: (reply: DiagnosticReply<{ appended: true }>) => void,
  ): void;
  reopenRuntimeJournalFixture(
    callback: (reply: DiagnosticReply<{ reopened: true }>) => void,
  ): void;
  getRuntimeJournalFixtureReceipt(
    callback: (reply: DiagnosticReply<RuntimeJournalFixtureReceipt>) => void,
  ): void;
  restoreRuntimeJournalFixture(
    callback: (reply: DiagnosticReply<{ restored: true }>) => void,
  ): void;
  exerciseNavigationStackBoundary(
    callback: (reply: DiagnosticReply<NavigationStackBoundaryReceipt>) => void,
  ): void;
  exerciseRuntimeEventFieldBoundaries(
    callback: (
      reply: DiagnosticReply<RuntimeEventFieldBoundaryReceipt>,
    ) => void,
  ): void;
  captureStaleAuthorities(
    callback: (reply: DiagnosticReply<{ captured: true }>) => void,
  ): void;
  armNextPageAdmissionPending(
    callback: (reply: DiagnosticReply<{ armed: true }>) => void,
  ): void;
  armNextPageFatalFailure(
    callback: (reply: DiagnosticReply<{ armed: true }>) => void,
  ): void;
  triggerReload(
    callback: (
      reply: DiagnosticReply<{
        status: "TRANSITION_ACCEPTED";
        transitionId: string;
      }>,
    ) => void,
  ): void;
  triggerTopPendingAdmissionFailure(
    callback: (reply: DiagnosticReply<{ triggered: boolean }>) => void,
  ): void;
  verifyStaleAuthorities(
    callback: (
      reply: DiagnosticReply<{ rejectedCount: number; verified: true }>,
    ) => void,
  ): void;
};

export type RuntimeJournalFixtureMode =
  | "retention-limit"
  | "count-plus-one"
  | "byte-plus-one"
  | "corrupt-json"
  | "noncanonical"
  | "already-oversized";

export type RuntimeJournalFixtureReceipt = {
  readonly snapshot: {
    readonly schemaVersion: 1;
    readonly latestSequence: string | null;
    readonly oldestSequence: string | null;
    readonly truncated: boolean;
    readonly events: readonly unknown[];
  };
  readonly byteLength: number;
  readonly sha256: string;
  readonly canonicalUtf8: string | null;
};

export type NavigationStackBoundaryReceipt = {
  readonly acceptedDepths: readonly number[];
  readonly acceptedContextIds: readonly string[];
  readonly rejectionCode: "STACK_LIMIT_EXCEEDED";
  readonly before: Readonly<Record<string, unknown>>;
  readonly beforeRejected: Readonly<Record<string, unknown>>;
  readonly afterRejected: Readonly<Record<string, unknown>>;
  readonly nativeDepthBeforeRejected: number;
  readonly nativeDepthAfterRejected: number;
};

export type RuntimeEventFieldBoundaryReceipt = {
  readonly exactNameAccepted: true;
  readonly namePlusOneRejected: true;
  readonly exactDetailsAccepted: true;
  readonly detailsPlusOneRejected: true;
  readonly beforeLatestSequence: string | null;
  readonly afterLatestSequence: string;
  readonly acceptedSequenceCount: 2;
};

declare const NativeModules:
  | { readonly HotUpdaterLynxDiagnostics?: DiagnosticsModule }
  | undefined;

export function callE2eDiagnostic<T>(
  method: keyof DiagnosticsModule,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const module =
      typeof NativeModules === "undefined"
        ? undefined
        : NativeModules.HotUpdaterLynxDiagnostics;
    const operation = module?.[method];
    if (typeof operation !== "function") {
      reject(new Error(`HotUpdaterLynxDiagnostics.${method} is unavailable`));
      return;
    }
    const invoke = operation as unknown as (
      callback: (reply: DiagnosticReply<T>) => void,
    ) => void;
    invoke.call(module, (reply) => {
      if (reply?.ok === true) resolve(reply.data);
      else if (reply?.ok === false) {
        reject(new Error(`${reply.error.code}: ${reply.error.message}`));
      } else {
        reject(
          new Error(`HotUpdaterLynxDiagnostics.${method} replied invalidly`),
        );
      }
    });
  });
}

export function callE2eDiagnosticWithOptions<T>(
  method: keyof DiagnosticsModule,
  options: Readonly<Record<string, unknown>>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const module =
      typeof NativeModules === "undefined"
        ? undefined
        : NativeModules.HotUpdaterLynxDiagnostics;
    const operation = module?.[method];
    if (typeof operation !== "function") {
      reject(new Error(`HotUpdaterLynxDiagnostics.${method} is unavailable`));
      return;
    }
    const invoke = operation as unknown as (
      input: Readonly<Record<string, unknown>>,
      callback: (reply: DiagnosticReply<T>) => void,
    ) => void;
    invoke.call(module, options, (reply) => {
      if (reply?.ok === true) resolve(reply.data);
      else if (reply?.ok === false) {
        reject(new Error(`${reply.error.code}: ${reply.error.message}`));
      } else {
        reject(
          new Error(`HotUpdaterLynxDiagnostics.${method} replied invalidly`),
        );
      }
    });
  });
}
