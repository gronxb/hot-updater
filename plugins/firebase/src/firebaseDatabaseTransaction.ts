import type { DatabasePluginDeclaration } from "@hot-updater/plugin-core";
import type admin from "firebase-admin";

import {
  createFirebaseTransactionConnection,
  getTargetAppVersionDocId,
  type FirebaseTransactionAttempt,
  type FirebaseTransactionBundle,
  type FirebaseTransactionOperation,
} from "./firebaseDatabaseTransactionState";

export { getTargetAppVersionDocId } from "./firebaseDatabaseTransactionState";
export type { FirebaseTransactionBundle } from "./firebaseDatabaseTransactionState";

export type FirebaseTransactionContext = {
  readonly readBundles: () => Promise<
    readonly {
      readonly id: string;
      readonly data: admin.firestore.DocumentData;
    }[]
  >;
  readonly setBundle: (
    bundleId: string,
    data: admin.firestore.DocumentData,
  ) => void;
  readonly deleteBundle: (bundleId: string) => void;
  readonly setChannel: (channel: string) => void;
  readonly deleteChannel: (channel: string) => void;
  readonly setTargetAppVersion: (
    docId: string,
    bundle: FirebaseTransactionBundle["record"],
  ) => void;
  readonly deleteTargetAppVersion: (docId: string) => void;
};

type FirebaseTransactionOptions = {
  readonly runTransaction: (
    callback: (transaction: FirebaseTransactionContext) => Promise<void>,
  ) => Promise<void>;
  readonly decodeBundle: (
    data: admin.firestore.DocumentData,
  ) => FirebaseTransactionBundle;
  readonly encodeBundle: (
    bundle: FirebaseTransactionBundle,
  ) => admin.firestore.DocumentData;
};

type TransactionDecision = "commit" | "rollback";

type TransactionLifecycle = {
  readonly connection: DatabasePluginDeclaration;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
};

class FirebaseTransactionRollbackError extends Error {
  constructor() {
    super("Firebase database transaction was rolled back.");
    this.name = "FirebaseTransactionRollbackError";
  }
}

const writeTransactionAttempt = (
  transaction: FirebaseTransactionContext,
  attempt: FirebaseTransactionAttempt,
  options: FirebaseTransactionOptions,
): void => {
  const impactedChannels = new Set<string>();
  const impactedTargetAppVersions = new Set<string>();

  for (const bundleId of attempt.touchedBundleIds) {
    const original = attempt.originalBundles.get(bundleId);
    const current = attempt.bundles.get(bundleId);
    if (original) {
      impactedChannels.add(original.record.channel);
      const targetAppVersionDocId = getTargetAppVersionDocId(original.record);
      if (targetAppVersionDocId) {
        impactedTargetAppVersions.add(targetAppVersionDocId);
      }
    }
    if (current) {
      impactedChannels.add(current.record.channel);
      const targetAppVersionDocId = getTargetAppVersionDocId(current.record);
      if (targetAppVersionDocId) {
        impactedTargetAppVersions.add(targetAppVersionDocId);
      }
      transaction.setBundle(bundleId, options.encodeBundle(current));
    } else {
      transaction.deleteBundle(bundleId);
    }
  }

  for (const channel of impactedChannels) {
    const hasChannel = Array.from(attempt.bundles.values()).some(
      (bundle) => bundle.record.channel === channel,
    );
    if (hasChannel) {
      transaction.setChannel(channel);
    } else {
      transaction.deleteChannel(channel);
    }
  }

  for (const targetAppVersionDocId of impactedTargetAppVersions) {
    const bundle = Array.from(attempt.bundles.values()).find(
      (candidate) =>
        getTargetAppVersionDocId(candidate.record) === targetAppVersionDocId,
    );
    if (bundle?.record.targetAppVersion) {
      transaction.setTargetAppVersion(targetAppVersionDocId, bundle.record);
    } else {
      transaction.deleteTargetAppVersion(targetAppVersionDocId);
    }
  }
};

export const beginFirebaseDatabaseTransaction = async (
  options: FirebaseTransactionOptions,
): Promise<TransactionLifecycle> => {
  const operations: FirebaseTransactionOperation[] = [];
  let resolveDecision: ((decision: TransactionDecision) => void) | undefined;
  let resolveConnection:
    | ((connection: DatabasePluginDeclaration) => void)
    | undefined;
  let rejectConnection: ((error: unknown) => void) | undefined;
  let connectionSettled = false;
  let decisionSettled = false;

  const decisionPromise = new Promise<TransactionDecision>((resolve) => {
    resolveDecision = resolve;
  });
  const connectionPromise = new Promise<DatabasePluginDeclaration>(
    (resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    },
  );
  const decide = (decision: TransactionDecision): void => {
    if (decisionSettled) {
      return;
    }
    decisionSettled = true;
    resolveDecision?.(decision);
  };

  const transactionResult = options.runTransaction(async (transaction) => {
    try {
      const documents = await transaction.readBundles();
      const originalBundles = new Map(
        documents.map((document) => [
          document.id,
          options.decodeBundle(document.data),
        ]),
      );
      const attempt: FirebaseTransactionAttempt = {
        originalBundles,
        bundles: new Map(originalBundles),
        touchedBundleIds: new Set(),
      };

      if (!connectionSettled) {
        connectionSettled = true;
        resolveConnection?.(
          createFirebaseTransactionConnection(attempt, (operation) => {
            operation(attempt);
            operations.push(operation);
          }),
        );
      } else {
        for (const operation of operations) {
          operation(attempt);
        }
      }

      const decision = await decisionPromise;
      if (decision === "rollback") {
        throw new FirebaseTransactionRollbackError();
      }
      writeTransactionAttempt(transaction, attempt, options);
    } catch (error) {
      if (!connectionSettled) {
        connectionSettled = true;
        rejectConnection?.(error);
      }
      throw error;
    }
  });

  void transactionResult.then(
    () => undefined,
    (error: unknown) => {
      if (!connectionSettled) {
        connectionSettled = true;
        rejectConnection?.(error);
      }
    },
  );

  const connection = await connectionPromise;
  return {
    connection,
    commit: async () => {
      decide("commit");
      await transactionResult;
    },
    rollback: async () => {
      decide("rollback");
      await transactionResult.then(
        () => undefined,
        () => undefined,
      );
    },
  };
};
