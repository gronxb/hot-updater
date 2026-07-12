import type { DatabaseBackendCommitRequestV2 } from "./backend";
import type { BundleChangeV2 } from "./bundles";
import {
  createMapV2,
  deleteMapValueV2,
  getMapValueV2,
  setMapValueV2,
} from "./collectionIntrinsics";
import { cloneInMemoryBundleV2, cloneInMemoryReceiptV2 } from "./inMemoryClone";
import type { InMemoryStoredBundleV2 } from "./inMemoryTypes";
import type { CommitReceiptV2, ReceiptIdentityV2 } from "./receipts";

type PersistedReceiptV2 =
  | (ReceiptIdentityV2 & {
      readonly outcome: "committed";
      readonly revisions: Readonly<Record<string, string>>;
    })
  | (ReceiptIdentityV2 & {
      readonly outcome: "rejected";
      readonly reason: "conflict" | "unsupported";
    });

interface PreparedMutationV2 {
  readonly id: string;
  readonly revision: string;
  readonly value: InMemoryStoredBundleV2 | null;
}

export interface InMemoryCommitStateV2 {
  readonly receipts: Map<string, PersistedReceiptV2>;
  readonly rowsByTenant: Map<string, Map<string, InMemoryStoredBundleV2>>;
  nextRevision: number;
}

const bundleId = (change: BundleChangeV2): string => {
  switch (change.type) {
    case "put":
      return change.value.id;
    case "delete":
      return change.id;
  }
};

const receiptKey = (request: DatabaseBackendCommitRequestV2): string =>
  JSON.stringify([
    request.scope.tenantId,
    request.scope.principalId,
    request.scope.scopeId,
    request.changeSet.id,
  ]);

const identity = (request: DatabaseBackendCommitRequestV2) => ({
  changeSetId: request.changeSet.id,
  scopeId: request.scope.scopeId,
  canonicalPayloadHash: request.canonicalPayloadHash,
});

const replayPersistedReceipt = (
  receipt: PersistedReceiptV2,
): CommitReceiptV2 => {
  switch (receipt.outcome) {
    case "committed":
      return cloneInMemoryReceiptV2({ ...receipt, outcome: "replayed" });
    case "rejected":
      return cloneInMemoryReceiptV2(receipt);
  }
};

const resolveExistingReceipt = (
  request: DatabaseBackendCommitRequestV2,
  existing: PersistedReceiptV2,
): CommitReceiptV2 => {
  if (existing.canonicalPayloadHash === request.canonicalPayloadHash) {
    return replayPersistedReceipt(existing);
  }
  return Object.freeze({
    ...identity(request),
    outcome: "rejected",
    reason: "conflict",
  });
};

const preconditionMatches = (
  change: BundleChangeV2,
  row: InMemoryStoredBundleV2 | undefined,
): boolean => {
  switch (change.type) {
    case "put":
      switch (change.precondition.state) {
        case "absent":
          return row === undefined;
        case "revision":
          return row?.revision === change.precondition.revision;
      }
    case "delete":
      return row?.revision === change.precondition.revision;
  }
};

const rejectConflict = (
  request: DatabaseBackendCommitRequestV2,
  key: string,
  state: InMemoryCommitStateV2,
): CommitReceiptV2 => {
  const receipt = Object.freeze({
    ...identity(request),
    outcome: "rejected",
    reason: "conflict",
  }) satisfies PersistedReceiptV2;
  setMapValueV2(state.receipts, key, receipt);
  return cloneInMemoryReceiptV2(receipt);
};

const prepareMutations = (
  request: DatabaseBackendCommitRequestV2,
  rows: Map<string, InMemoryStoredBundleV2>,
  state: InMemoryCommitStateV2,
): readonly PreparedMutationV2[] => {
  let revision = state.nextRevision;
  return request.changeSet.changes.map((change) => {
    revision += 1;
    const nextRevision = `memory-revision-v2:${revision.toString(36)}`;
    switch (change.type) {
      case "put":
        return {
          id: change.value.id,
          revision: nextRevision,
          value: Object.freeze({
            value: cloneInMemoryBundleV2(change.value),
            revision: nextRevision,
          }),
        };
      case "delete":
        return { id: change.id, revision: nextRevision, value: null };
    }
  });
};

export const commitInMemoryChangeSetV2 = (
  request: DatabaseBackendCommitRequestV2,
  state: InMemoryCommitStateV2,
): CommitReceiptV2 => {
  const key = receiptKey(request);
  const existing = getMapValueV2(state.receipts, key);
  if (existing !== undefined) {
    return resolveExistingReceipt(request, existing);
  }
  const rows =
    getMapValueV2(state.rowsByTenant, request.scope.tenantId) ??
    createMapV2<string, InMemoryStoredBundleV2>();
  if (
    request.changeSet.changes.some(
      (change) =>
        !preconditionMatches(change, getMapValueV2(rows, bundleId(change))),
    )
  ) {
    return rejectConflict(request, key, state);
  }
  const mutations = prepareMutations(request, rows, state);
  const revisions = Object.fromEntries(
    mutations.map((mutation) => [mutation.id, mutation.revision]),
  );
  for (const mutation of mutations) {
    if (mutation.value === null) {
      deleteMapValueV2(rows, mutation.id);
    } else {
      setMapValueV2(rows, mutation.id, mutation.value);
    }
  }
  state.nextRevision += mutations.length;
  setMapValueV2(state.rowsByTenant, request.scope.tenantId, rows);
  const receipt = Object.freeze({
    ...identity(request),
    outcome: "committed",
    revisions: Object.freeze(revisions),
  }) satisfies PersistedReceiptV2;
  setMapValueV2(state.receipts, key, receipt);
  return cloneInMemoryReceiptV2(receipt);
};
