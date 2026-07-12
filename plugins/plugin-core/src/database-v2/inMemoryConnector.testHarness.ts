import type {
  DatabaseConnectorV2TestFaults,
  DatabaseConnectorV2TestHarness,
  DatabaseConnectorV2TestInstrumentation,
  DatabaseConnectorV2TestSubject,
} from "@hot-updater/test-utils";
import type { DatabaseConnectorV2TestContext } from "@hot-updater/test-utils";

import type {
  DatabaseBackendCommitRequestV2,
  DatabaseBackendV2,
} from "./backend";
import { createInMemoryDatabaseBackendV2 } from "./inMemoryBackend";
import { createDatabaseConnectionRuntimeV2 } from "./sessionRuntime";

type InterruptionStageV2 = "before-durability" | "after-durability";

interface DeferredV2 {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const createDeferredV2 = (): DeferredV2 => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const unknownReceipt = (request: DatabaseBackendCommitRequestV2) =>
  Object.freeze({
    changeSetId: request.changeSet.id,
    scopeId: request.scope.scopeId,
    canonicalPayloadHash: request.canonicalPayloadHash,
    outcome: "unknown",
    reason: "transport-unknown",
    sessionState: "poisoned",
    retry: "identical-scope-id-and-payload-only",
  });

class InstrumentedInMemoryBackendV2 implements DatabaseBackendV2 {
  private operationAttempts = 0;
  private commitAttempts = 0;
  private mutations = 0;
  private hold = false;
  private held = createDeferredV2();
  private release = createDeferredV2();
  private interruption: InterruptionStageV2 | null = null;

  constructor(private readonly backend: DatabaseBackendV2) {}

  readonly instrumentation: DatabaseConnectorV2TestInstrumentation = {
    backendOperationAttempts: () => this.operationAttempts,
    backendCommitAttempts: () => this.commitAttempts,
    domainMutationCount: () => this.mutations,
  };

  readonly faults: DatabaseConnectorV2TestFaults = {
    holdNextCommit: () => {
      this.hold = true;
      this.held = createDeferredV2();
      this.release = createDeferredV2();
    },
    waitForHeldCommit: async () => await this.held.promise,
    releaseHeldCommit: () => this.release.resolve(),
    interruptNextCommit: (stage) => {
      this.interruption = stage;
    },
  };

  async get(...parameters: Parameters<DatabaseBackendV2["get"]>) {
    this.operationAttempts += 1;
    return await this.backend.get(...parameters);
  }

  async page(...parameters: Parameters<DatabaseBackendV2["page"]>) {
    this.operationAttempts += 1;
    return await this.backend.page(...parameters);
  }

  async channels(...parameters: Parameters<DatabaseBackendV2["channels"]>) {
    this.operationAttempts += 1;
    return await this.backend.channels(...parameters);
  }

  async commit(request: DatabaseBackendCommitRequestV2): Promise<unknown> {
    this.operationAttempts += 1;
    this.commitAttempts += 1;
    if (this.hold) {
      this.hold = false;
      this.held.resolve();
      await this.release.promise;
    }
    const interruption = this.interruption;
    this.interruption = null;
    if (interruption === "before-durability") {
      return unknownReceipt(request);
    }
    const receipt = await this.backend.commit(request);
    if (
      typeof receipt === "object" &&
      receipt !== null &&
      Reflect.get(receipt, "outcome") === "committed"
    ) {
      this.mutations += request.changeSet.changes.length;
    }
    return interruption === "after-durability"
      ? unknownReceipt(request)
      : receipt;
  }
}

export const inMemoryConnectorV2TestHarness = {
  createSubject: (): DatabaseConnectorV2TestSubject => {
    const backend = new InstrumentedInMemoryBackendV2(
      createInMemoryDatabaseBackendV2(),
    );
    return {
      connector: {
        connect: () =>
          createDatabaseConnectionRuntimeV2<DatabaseConnectorV2TestContext>({
            backend,
            resource: { ownership: "borrowed" },
          }),
      },
      instrumentation: backend.instrumentation,
      faults: backend.faults,
    };
  },
} satisfies DatabaseConnectorV2TestHarness;
