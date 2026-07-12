import { assertDatabaseConnectorV2 } from "./assertions";
import {
  DATABASE_V2_BUNDLE_IDS,
  DATABASE_V2_CHANGE_SET_IDS,
  DATABASE_V2_SCOPE_ALPHA,
  DATABASE_V2_SCOPE_BETA,
  createDatabaseV2PutChangeSet,
  createDatabaseV2TestBundle,
} from "./fixtures";
import type {
  DatabaseConnectorV2TestChangeSet,
  DatabaseConnectorV2TestHarness,
} from "./types";

export async function runDatabaseV2AtomicityScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("atomicity");
  const connection = await subject.connector.connect();
  const session = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const first = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.first,
    "production",
  );
  const missingRevision = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.second,
    "production",
  );
  const beforeMutations = subject.instrumentation.domainMutationCount();
  const changeSet: DatabaseConnectorV2TestChangeSet = {
    id: DATABASE_V2_CHANGE_SET_IDS.seed,
    changes: [
      { type: "put", value: first, precondition: { state: "absent" } },
      {
        type: "put",
        value: missingRevision,
        precondition: { state: "revision", revision: "missing-revision" },
      },
    ],
  };

  const receipt = await session.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    receipt.outcome === "rejected" && receipt.reason === "conflict",
    "atomicity",
    "one failed precondition must reject the whole change set",
  );
  assertDatabaseConnectorV2(
    subject.instrumentation.domainMutationCount() === beforeMutations &&
      (await session.bundles.get(first.id)) === null &&
      (await session.bundles.get(missingRevision.id)) === null,
    "atomicity",
    "a rejected multi-change commit must not partially write rows",
  );

  const sameSessionReplay = await session.applyChangeSet(changeSet);
  const freshSession = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const freshSessionReplay = await freshSession.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    sameSessionReplay.outcome === "rejected" &&
      freshSessionReplay.outcome === "rejected" &&
      sameSessionReplay.reason === receipt.reason &&
      freshSessionReplay.canonicalPayloadHash ===
        receipt.canonicalPayloadHash &&
      subject.instrumentation.domainMutationCount() === beforeMutations,
    "replay-identity",
    "rejected receipts must replay in same and fresh sessions without row writes",
  );
}

export async function runDatabaseV2ReplayScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("receipt-replay");
  const connection = await subject.connector.connect();
  const alpha = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const bundle = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.first,
    "production",
  );
  const changeSet = createDatabaseV2PutChangeSet(
    DATABASE_V2_CHANGE_SET_IDS.replay,
    [bundle],
  );
  const committed = await alpha.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    committed.outcome === "committed",
    "replay-identity",
    "the initial change set must commit",
  );
  const afterCommit = subject.instrumentation.domainMutationCount();
  const replayed = await alpha.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    replayed.outcome === "replayed" &&
      replayed.canonicalPayloadHash === committed.canonicalPayloadHash &&
      replayed.scopeId === committed.scopeId &&
      replayed.revisions[bundle.id] === committed.revisions[bundle.id] &&
      subject.instrumentation.domainMutationCount() === afterCommit,
    "replay-identity",
    "same-session replay must preserve identity/revisions without domain writes",
  );

  const freshConnection = await subject.connector.connect();
  const freshAlpha = await freshConnection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const freshReplay = await freshAlpha.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    freshReplay.outcome === "replayed" &&
      freshReplay.revisions[bundle.id] === committed.revisions[bundle.id] &&
      subject.instrumentation.domainMutationCount() === afterCommit,
    "replay-identity",
    "fresh-session replay must preserve the connector-lifetime receipt",
  );

  const collisionBundle = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.second,
    "collision",
  );
  const collision = await freshAlpha.applyChangeSet(
    createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.replay, [
      collisionBundle,
    ]),
  );
  assertDatabaseConnectorV2(
    collision.outcome === "rejected" &&
      collision.reason === "conflict" &&
      subject.instrumentation.domainMutationCount() === afterCommit,
    "replay-identity",
    "same ID with a different payload must conflict without replacing the receipt",
  );
  const originalAfterCollision = await freshAlpha.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    originalAfterCollision.outcome === "replayed" &&
      originalAfterCollision.scopeId === committed.scopeId &&
      originalAfterCollision.canonicalPayloadHash ===
        committed.canonicalPayloadHash &&
      originalAfterCollision.revisions[bundle.id] ===
        committed.revisions[bundle.id] &&
      subject.instrumentation.domainMutationCount() === afterCommit,
    "replay-identity",
    "a payload collision must not replace the original replay receipt",
  );

  const beta = await freshConnection.openSession(DATABASE_V2_SCOPE_BETA);
  const independent = await beta.applyChangeSet(
    createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.replay, [
      collisionBundle,
    ]),
  );
  assertDatabaseConnectorV2(
    independent.outcome === "committed" &&
      independent.scopeId !== committed.scopeId,
    "replay-identity",
    "the same ID under another principal must be an independent attempt",
  );
}
