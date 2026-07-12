import {
  assertDatabaseConnectorV2,
  assertDatabaseConnectorV2Error,
} from "./assertions";
import {
  DATABASE_V2_BUNDLE_IDS,
  DATABASE_V2_CHANGE_SET_IDS,
  DATABASE_V2_SCOPE_ALPHA,
  createDatabaseV2PutChangeSet,
  createDatabaseV2TestBundle,
} from "./fixtures";
import type { DatabaseConnectorV2TestHarness } from "./types";

export async function runDatabaseV2ConcurrentCommitScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("concurrent-commit");
  const connection = await subject.connector.connect();
  const session = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const first = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.first,
    "production",
  );
  const second = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.second,
    "production",
  );
  subject.faults.holdNextCommit();
  const commitA = session.applyChangeSet(
    createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.concurrentA, [
      first,
    ]),
  );
  await subject.faults.waitForHeldCommit();
  const attemptsDuringA = subject.instrumentation.backendCommitAttempts();

  try {
    await assertDatabaseConnectorV2Error(
      () =>
        session.applyChangeSet(
          createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.concurrentB, [
            second,
          ]),
        ),
      "CONCURRENT_COMMIT",
      "concurrent-zero-io",
    );
    assertDatabaseConnectorV2(
      subject.instrumentation.backendCommitAttempts() === attemptsDuringA,
      "concurrent-zero-io",
      "the second concurrent commit must be rejected before backend I/O",
    );
  } finally {
    subject.faults.releaseHeldCommit();
  }

  const committed = await commitA;
  assertDatabaseConnectorV2(
    committed.outcome === "committed",
    "concurrent-zero-io",
    "releasing the held first commit must let it finish",
  );
}

export async function runDatabaseV2UnknownRecoveryScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("unknown-recovery");
  const connection = await subject.connector.connect();
  const session = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const bundle = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.first,
    "production",
  );
  const changeSet = createDatabaseV2PutChangeSet(
    DATABASE_V2_CHANGE_SET_IDS.unknown,
    [bundle],
  );

  subject.faults.interruptNextCommit("before-durability");
  const firstUnknown = await session.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    firstUnknown.outcome === "unknown",
    "unknown-recovery",
    "an interrupted commit must return an unknown receipt",
  );
  await assertDatabaseConnectorV2Error(
    () => session.bundles.get(bundle.id),
    "SESSION_POISONED",
    "unknown-recovery",
  );
  await assertDatabaseConnectorV2Error(
    () =>
      session.applyChangeSet(
        createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.concurrentB, [
          bundle,
        ]),
      ),
    "SESSION_POISONED",
    "unknown-recovery",
  );

  subject.faults.interruptNextCommit("before-durability");
  const secondUnknown = await session.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    secondUnknown.outcome === "unknown",
    "unknown-recovery",
    "a repeated identical interruption must keep the session poisoned",
  );
  await assertDatabaseConnectorV2Error(
    () => session.bundles.get(bundle.id),
    "SESSION_POISONED",
    "unknown-recovery",
  );

  const recovered = await session.applyChangeSet(changeSet);
  assertDatabaseConnectorV2(
    recovered.outcome === "committed" &&
      (await session.bundles.get(bundle.id))?.value.id === bundle.id,
    "unknown-recovery",
    "an identical definitive retry must recover and unpoison the session",
  );

  const durableBundle = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.second,
    "durable",
  );
  const durableChange = createDatabaseV2PutChangeSet(
    "10000000-0000-4000-8000-000000000008",
    [durableBundle],
  );
  subject.faults.interruptNextCommit("after-durability");
  const afterDurability = await session.applyChangeSet(durableChange);
  assertDatabaseConnectorV2(
    afterDurability.outcome === "unknown",
    "unknown-recovery",
    "an after-durability interruption must still report unknown",
  );
  await session.close();
  const fresh = await connection.openSession(DATABASE_V2_SCOPE_ALPHA);
  const durableReplay = await fresh.applyChangeSet(durableChange);
  assertDatabaseConnectorV2(
    durableReplay.outcome === "replayed" &&
      (await fresh.bundles.get(durableBundle.id))?.value.id ===
        durableBundle.id,
    "unknown-recovery",
    "fresh-session exact retry must discover a durable committed receipt",
  );
}
