import type { Bundle } from "@hot-updater/core";

import type { BundlePageV2 } from "./bundles";
import type { Versioned } from "./common";
import type { CommitReceiptV2 } from "./receipts";
import type {
  TestBackendCommitRequestV2,
  TestBackendScopeV2,
  TestDatabaseBackendV2,
} from "./sessionRuntime.testTypes";

export class RuntimeDeferred<T> {
  readonly promise: Promise<T>;
  private resolver: ((value: T) => void) | undefined;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolver = resolve;
    });
  }

  resolve(value: T): void {
    const resolver = this.resolver;
    if (resolver === undefined) {
      throw new TypeError("runtime deferred was not initialized");
    }
    resolver(value);
  }
}

type CommitScript =
  | { readonly kind: "unknown-before" }
  | { readonly kind: "unknown-after" }
  | { readonly kind: "unknown-repeated" }
  | { readonly kind: "rejected" }
  | { readonly kind: "protocol-identity" }
  | { readonly kind: "protocol-revisions" };

type ReceiptDefect = (request: TestBackendCommitRequestV2) => unknown;

const receiptKey = (request: TestBackendCommitRequestV2): string =>
  `${request.scope.tenantId}\0${request.scope.principalId}\0${request.changeSet.id}`;

const unknownReceipt = (
  request: TestBackendCommitRequestV2,
): CommitReceiptV2 => ({
  changeSetId: request.changeSet.id,
  scopeId: request.scope.scopeId,
  canonicalPayloadHash: request.canonicalPayloadHash,
  outcome: "unknown",
  reason: "transport-unknown",
  sessionState: "poisoned",
  retry: "identical-scope-id-and-payload-only",
});

export class ScriptedRuntimeBackend implements TestDatabaseBackendV2 {
  readonly observedScopes: TestBackendScopeV2[] = [];
  readonly observedCommits: TestBackendCommitRequestV2[] = [];
  readonly receipts = new Map<string, CommitReceiptV2>();
  readonly rows = new Map<string, Versioned<Bundle>>();
  commitAttempts = 0;
  readAttempts = 0;
  interveningTenantMutations = 0;
  private revision = 0;
  private receiptDefects: ReceiptDefect[] = [];
  private scripts: CommitScript[] = [];
  private held: RuntimeDeferred<void> | null = null;
  private entered: RuntimeDeferred<void> | null = null;

  enqueue(script: CommitScript): void {
    this.scripts.push(script);
  }

  queueReceiptDefect(defect: ReceiptDefect): void {
    this.receiptDefects.push(defect);
  }

  mutateTenantBeforeRecovery(): void {
    this.interveningTenantMutations += 1;
    this.scripts.push({ kind: "rejected" });
  }

  holdNextCommit(): Promise<void> {
    this.held = new RuntimeDeferred<void>();
    this.entered = new RuntimeDeferred<void>();
    return this.entered.promise;
  }

  releaseCommit(): void {
    const held = this.held;
    if (held === null) {
      throw new TypeError("no held commit");
    }
    held.resolve();
    this.held = null;
  }

  releaseCommitIfHeld(): void {
    if (this.held !== null) {
      this.releaseCommit();
    }
  }

  async get(
    scope: TestBackendScopeV2,
    id: string,
  ): Promise<Versioned<Bundle> | null> {
    this.readAttempts += 1;
    this.observedScopes.push(scope);
    return this.rows.get(`${scope.tenantId}\0${id}`) ?? null;
  }

  async page(scope: TestBackendScopeV2): Promise<BundlePageV2> {
    this.readAttempts += 1;
    this.observedScopes.push(scope);
    return {
      data: [],
      pagination: {
        total: 0,
        hasNextPage: false,
        hasPreviousPage: false,
        nextCursor: null,
        previousCursor: null,
      },
    };
  }

  async channels(scope: TestBackendScopeV2): Promise<readonly string[]> {
    this.readAttempts += 1;
    this.observedScopes.push(scope);
    return [];
  }

  async commit(request: TestBackendCommitRequestV2): Promise<unknown> {
    this.commitAttempts += 1;
    this.observedCommits.push(request);
    const entered = this.entered;
    const held = this.held;
    if (entered !== null && held !== null) {
      entered.resolve();
      this.entered = null;
      await held.promise;
    }
    const receiptDefect = this.receiptDefects.shift();
    if (receiptDefect !== undefined) {
      return Reflect.apply(receiptDefect, undefined, [request]);
    }
    const existing = this.receipts.get(receiptKey(request));
    if (existing?.outcome === "committed") {
      return { ...existing, outcome: "replayed" };
    }
    if (existing !== undefined) {
      return existing;
    }
    const script = this.scripts.shift();
    if (
      script?.kind === "unknown-before" ||
      script?.kind === "unknown-repeated"
    ) {
      return unknownReceipt(request);
    }
    if (script?.kind === "rejected") {
      const rejected = {
        changeSetId: request.changeSet.id,
        scopeId: request.scope.scopeId,
        canonicalPayloadHash: request.canonicalPayloadHash,
        outcome: "rejected",
        reason: "conflict",
      } as const;
      this.receipts.set(receiptKey(request), rejected);
      return rejected;
    }
    if (script?.kind === "protocol-identity") {
      return { ...unknownReceipt(request), scopeId: "sha256:wrong" };
    }
    if (script?.kind === "protocol-revisions") {
      return {
        changeSetId: request.changeSet.id,
        scopeId: request.scope.scopeId,
        canonicalPayloadHash: request.canonicalPayloadHash,
        outcome: "committed",
        revisions: {},
      };
    }
    const committed = this.commitRequest(request);
    if (script?.kind === "unknown-after") {
      return unknownReceipt(request);
    }
    return committed;
  }

  private commitRequest(request: TestBackendCommitRequestV2): CommitReceiptV2 {
    this.revision += 1;
    const revisions: Record<string, string> = {};
    for (const change of request.changeSet.changes) {
      const id = change.type === "put" ? change.value.id : change.id;
      revisions[id] = `revision-${this.revision}`;
      if (change.type === "put") {
        this.rows.set(`${request.scope.tenantId}\0${id}`, {
          value: change.value,
          revision: revisions[id],
        });
      } else {
        this.rows.delete(`${request.scope.tenantId}\0${id}`);
      }
    }
    const committed = {
      changeSetId: request.changeSet.id,
      scopeId: request.scope.scopeId,
      canonicalPayloadHash: request.canonicalPayloadHash,
      outcome: "committed",
      revisions,
    } as const;
    this.receipts.set(receiptKey(request), committed);
    return committed;
  }
}
