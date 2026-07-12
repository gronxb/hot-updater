import type { Bundle } from "@hot-updater/core";

export type DatabaseConnectorV2TestMaybePromise<T> = T | Promise<T>;

export interface DatabaseConnectorV2TestContext {
  readonly marker: string;
  readonly tenantId?: string;
  readonly principalId?: string;
}

export interface DatabaseConnectorV2TestScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly context: DatabaseConnectorV2TestContext;
}

export interface DatabaseConnectorV2TestVersionedBundle {
  readonly value: Bundle;
  readonly revision: string;
}

export interface DatabaseConnectorV2TestWhere {
  readonly channel?: string;
  readonly platform?: Bundle["platform"];
  readonly enabled?: boolean;
  readonly id?: {
    readonly eq?: string;
    readonly gt?: string;
    readonly gte?: string;
    readonly lt?: string;
    readonly lte?: string;
    readonly in?: readonly string[];
  };
  readonly targetAppVersion?: string | null;
  readonly targetAppVersionIn?: readonly string[];
  readonly targetAppVersionNotNull?: boolean;
  readonly fingerprintHash?: string | null;
}

export interface DatabaseConnectorV2TestPageQuery {
  readonly where?: DatabaseConnectorV2TestWhere;
  readonly limit: number;
  readonly cursor?:
    | { readonly after: string; readonly before?: never }
    | { readonly before: string; readonly after?: never };
  readonly orderBy?: {
    readonly field: "id";
    readonly direction: "asc" | "desc";
  };
}

export interface DatabaseConnectorV2TestPage {
  readonly data: readonly DatabaseConnectorV2TestVersionedBundle[];
  readonly pagination: {
    readonly total: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly nextCursor: string | null;
    readonly previousCursor: string | null;
  };
}

export type DatabaseConnectorV2TestChange =
  | {
      readonly type: "put";
      readonly value: Bundle;
      readonly precondition:
        | { readonly state: "absent" }
        | { readonly state: "revision"; readonly revision: string };
    }
  | {
      readonly type: "delete";
      readonly id: string;
      readonly precondition: {
        readonly state: "revision";
        readonly revision: string;
      };
    };

export interface DatabaseConnectorV2TestChangeSet {
  readonly id: string;
  readonly changes: readonly DatabaseConnectorV2TestChange[];
}

export type DatabaseConnectorV2TestReceipt =
  | {
      readonly changeSetId: string;
      readonly scopeId: string;
      readonly canonicalPayloadHash: string;
      readonly outcome: "committed" | "replayed";
      readonly revisions: Readonly<Record<string, string>>;
    }
  | {
      readonly changeSetId: string;
      readonly scopeId: string;
      readonly canonicalPayloadHash: string;
      readonly outcome: "rejected";
      readonly reason: "conflict" | "unsupported";
    }
  | {
      readonly changeSetId: string;
      readonly scopeId: string;
      readonly canonicalPayloadHash: string;
      readonly outcome: "unknown";
      readonly reason: "transport-unknown";
      readonly sessionState: "poisoned";
      readonly retry: "identical-scope-id-and-payload-only";
    };

export interface DatabaseConnectorV2TestRepository {
  get(id: string): Promise<DatabaseConnectorV2TestVersionedBundle | null>;
  page(
    query: DatabaseConnectorV2TestPageQuery,
  ): Promise<DatabaseConnectorV2TestPage>;
  channels(): Promise<readonly string[]>;
}

export interface DatabaseConnectorV2TestSession {
  readonly bundles: DatabaseConnectorV2TestRepository;
  applyChangeSet(
    changeSet: DatabaseConnectorV2TestChangeSet,
  ): Promise<DatabaseConnectorV2TestReceipt>;
  close(): Promise<void>;
}

export interface DatabaseConnectorV2TestConnection {
  openSession(
    scope: DatabaseConnectorV2TestScope,
  ): Promise<DatabaseConnectorV2TestSession>;
  close(): Promise<void>;
}

export interface DatabaseConnectorV2TestConnector {
  connect(): DatabaseConnectorV2TestMaybePromise<DatabaseConnectorV2TestConnection>;
}

export interface DatabaseConnectorV2TestInstrumentation {
  backendOperationAttempts(): number;
  backendCommitAttempts(): number;
  domainMutationCount(): number;
}

export interface DatabaseConnectorV2TestFaults {
  holdNextCommit(): void;
  waitForHeldCommit(): Promise<void>;
  releaseHeldCommit(): void;
  interruptNextCommit(stage: "before-durability" | "after-durability"): void;
}

export interface DatabaseConnectorV2TestSubject {
  readonly connector: DatabaseConnectorV2TestConnector;
  readonly instrumentation: DatabaseConnectorV2TestInstrumentation;
  readonly faults: DatabaseConnectorV2TestFaults;
}

export type DatabaseConnectorV2TestScenario =
  | "atomicity"
  | "concurrent-commit"
  | "cursor-binding"
  | "happy-read-and-scope"
  | "lifecycle"
  | "malformed-change-set"
  | "receipt-replay"
  | "unknown-recovery";

export interface DatabaseConnectorV2TestHarness {
  createSubject(
    scenario: DatabaseConnectorV2TestScenario,
  ): DatabaseConnectorV2TestMaybePromise<DatabaseConnectorV2TestSubject>;
}
