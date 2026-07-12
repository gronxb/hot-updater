import type { DatabaseBackendScopeV2, DatabaseBackendV2 } from "./backend";
import type { BundleChangeSetV2, BundleRepositoryV2 } from "./bundles";
import { snapshotDatabaseChangeSetV2 } from "./changeSetValidation";
import type { Sha256Digest } from "./common";
import type { DatabaseSessionV2 } from "./connector";
import { hashDatabaseChangeSetPayloadV1 } from "./databaseIdentity";
import { DatabaseConnectorErrorV2 } from "./errors";
import type { CommitReceiptV2 } from "./receipts";
import { validateCommitReceiptV2 } from "./receiptValidation";
import type {
  DatabaseSessionStateV2,
  PoisonedCommitIdentityV2,
  PreparedCommitV2,
} from "./sessionState";

interface DatabaseSessionRuntimeV2Options {
  readonly backend: DatabaseBackendV2;
  readonly scope: DatabaseBackendScopeV2;
  readonly sha256?: Sha256Digest;
  readonly onClosed: (session: DatabaseSessionRuntimeV2) => void;
}

interface ActiveAttemptV2 {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const createActiveAttempt = (): ActiveAttemptV2 => {
  let resolve = (): void => {
    throw new TypeError("active attempt was not initialized");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const sessionError = (
  code:
    | "CONCURRENT_COMMIT"
    | "SESSION_POISONED"
    | "SESSION_CLOSING"
    | "SESSION_CLOSED",
  message: string,
): DatabaseConnectorErrorV2 => new DatabaseConnectorErrorV2(code, message);

export class DatabaseSessionRuntimeV2 implements DatabaseSessionV2 {
  private state: DatabaseSessionStateV2 = "open";
  private poison: PoisonedCommitIdentityV2 | null = null;
  private activeAttempt: Promise<void> | null = null;
  private closeCompletion: Promise<void> | null = null;
  private readonly backend: DatabaseBackendV2;
  private readonly scope: DatabaseBackendScopeV2;
  private readonly sha256: Sha256Digest | undefined;
  private readonly onClosed: (session: DatabaseSessionRuntimeV2) => void;

  readonly bundles: BundleRepositoryV2 = {
    get: async (id) => {
      this.assertReadable();
      return await this.backend.get(this.scope, id);
    },
    page: async (query) => {
      this.assertReadable();
      return await this.backend.page(this.scope, query);
    },
    channels: async () => {
      this.assertReadable();
      return await this.backend.channels(this.scope);
    },
  };

  constructor(options: DatabaseSessionRuntimeV2Options) {
    this.backend = options.backend;
    this.scope = options.scope;
    this.sha256 = options.sha256;
    this.onClosed = options.onClosed;
  }

  async applyChangeSet(changeSet: BundleChangeSetV2): Promise<CommitReceiptV2> {
    const recovery = this.reserveCommit();
    const active = createActiveAttempt();
    this.activeAttempt = active.promise;
    try {
      const prepared = this.prepareCommit(changeSet, recovery);
      return await this.executeCommit(prepared);
    } finally {
      if (this.state === "committing") {
        this.restoreAfterPreparation(recovery);
      }
      active.resolve();
      this.activeAttempt = null;
    }
  }

  close(): Promise<void> {
    if (this.closeCompletion !== null) {
      return this.closeCompletion;
    }
    if (this.state === "closed") {
      return Promise.resolve();
    }
    this.state = "closing";
    const active = this.activeAttempt ?? Promise.resolve();
    this.closeCompletion = active.then(() => {
      this.state = "closed";
      this.poison = null;
      this.onClosed(this);
    });
    return this.closeCompletion;
  }

  private reserveCommit(): PoisonedCommitIdentityV2 | null {
    switch (this.state) {
      case "committing":
        throw sessionError("CONCURRENT_COMMIT", "a commit is already active");
      case "closing":
        throw sessionError("SESSION_CLOSING", "session is closing");
      case "closed":
        throw sessionError("SESSION_CLOSED", "session is closed");
      case "open": {
        this.state = "committing";
        return null;
      }
      case "poisoned": {
        const poison = this.poison;
        if (poison === null) {
          throw sessionError("SESSION_POISONED", "session is poisoned");
        }
        this.state = "committing";
        return poison;
      }
    }
  }

  private prepareCommit(
    changeSet: BundleChangeSetV2,
    recovery: PoisonedCommitIdentityV2 | null,
  ): PreparedCommitV2 {
    const snapshot = snapshotDatabaseChangeSetV2(changeSet);
    if (recovery !== null && recovery.changeSetId !== snapshot.id) {
      throw sessionError(
        "SESSION_POISONED",
        "only the exact unknown commit may be retried",
      );
    }
    return { changeSet: snapshot, recovery };
  }

  private async executeCommit(
    prepared: PreparedCommitV2,
  ): Promise<CommitReceiptV2> {
    const payloadHash = await this.hashChangeSet(prepared);
    if (
      prepared.recovery !== null &&
      prepared.recovery.canonicalPayloadHash !== payloadHash
    ) {
      this.restoreAfterPreparation(prepared.recovery);
      throw sessionError(
        "SESSION_POISONED",
        "only the exact unknown payload may be retried",
      );
    }
    const expected = {
      changeSetId: prepared.changeSet.id,
      scopeId: this.scope.scopeId,
      canonicalPayloadHash: payloadHash,
    };
    let receipt: unknown;
    try {
      receipt = await this.backend.commit({
        scope: this.scope,
        changeSet: prepared.changeSet,
        canonicalPayloadHash: payloadHash,
      });
    } catch {
      this.poisonWith(expected);
      throw new DatabaseConnectorErrorV2(
        "CONNECTOR_PROTOCOL_VIOLATION",
        "backend commit did not return a receipt",
      );
    }
    try {
      const validated = validateCommitReceiptV2(
        receipt,
        expected,
        prepared.changeSet,
      );
      if (validated.outcome === "unknown") {
        this.poisonWith(expected);
      } else {
        this.poison = null;
        this.transitionWhenOpen("open");
      }
      return validated;
    } catch (error) {
      this.poisonWith(expected);
      throw error;
    }
  }

  private async hashChangeSet(prepared: PreparedCommitV2): Promise<string> {
    try {
      return await hashDatabaseChangeSetPayloadV1(
        prepared.changeSet.changes,
        this.sha256,
      );
    } catch (error) {
      this.restoreAfterPreparation(prepared.recovery);
      if (
        error instanceof DatabaseConnectorErrorV2 &&
        error.code === "CANONICALIZATION_FAILED"
      ) {
        throw new DatabaseConnectorErrorV2(
          "INVALID_CHANGE_SET",
          "change set payload is not canonicalizable",
        );
      }
      throw error;
    }
  }

  private assertReadable(): void {
    switch (this.state) {
      case "open":
        return;
      case "poisoned":
        throw sessionError("SESSION_POISONED", "session is poisoned");
      case "committing":
        throw sessionError("CONCURRENT_COMMIT", "a commit is active");
      case "closing":
        throw sessionError("SESSION_CLOSING", "session is closing");
      case "closed":
        throw sessionError("SESSION_CLOSED", "session is closed");
    }
  }

  private poisonWith(identity: PoisonedCommitIdentityV2): void {
    this.poison = identity;
    this.transitionWhenOpen("poisoned");
  }

  private restoreAfterPreparation(
    recovery: PoisonedCommitIdentityV2 | null,
  ): void {
    this.poison = recovery;
    this.transitionWhenOpen(recovery === null ? "open" : "poisoned");
  }

  private transitionWhenOpen(
    state: Extract<DatabaseSessionStateV2, "open" | "poisoned">,
  ): void {
    if (this.state !== "closing" && this.state !== "closed") {
      this.state = state;
    }
  }
}
