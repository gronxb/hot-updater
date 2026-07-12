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

export async function runDatabaseV2LifecycleScenario(
  harness: DatabaseConnectorV2TestHarness,
): Promise<void> {
  const subject = await harness.createSubject("lifecycle");
  const firstConnection = await subject.connector.connect();
  const secondConnection = await subject.connector.connect();
  const firstSession = await firstConnection.openSession(
    DATABASE_V2_SCOPE_ALPHA,
  );
  const secondSession = await secondConnection.openSession(
    DATABASE_V2_SCOPE_ALPHA,
  );
  const bundle = createDatabaseV2TestBundle(
    DATABASE_V2_BUNDLE_IDS.first,
    "production",
  );
  await firstSession.applyChangeSet(
    createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.seed, [bundle]),
  );

  await Promise.all([firstSession.close(), firstSession.close()]);
  await assertDatabaseConnectorV2Error(
    () => firstSession.bundles.get(bundle.id),
    "SESSION_CLOSED",
    "lifecycle",
  );
  assertDatabaseConnectorV2(
    (await secondSession.bundles.get(bundle.id))?.value.id === bundle.id,
    "lifecycle",
    "closing one session or connection must not close an independent connection",
  );

  await Promise.all([firstConnection.close(), firstConnection.close()]);
  await assertDatabaseConnectorV2Error(
    () => firstConnection.openSession(DATABASE_V2_SCOPE_ALPHA),
    "CONNECTION_CLOSED",
    "lifecycle",
  );
  const freshConnection = await subject.connector.connect();
  const freshSession = await freshConnection.openSession(
    DATABASE_V2_SCOPE_ALPHA,
  );
  assertDatabaseConnectorV2(
    (await freshSession.bundles.get(bundle.id))?.value.id === bundle.id,
    "lifecycle",
    "a new connection must retain connector-lifetime state",
  );

  const idleSubject = await harness.createSubject("lifecycle");
  const idleConnection = await idleSubject.connector.connect();
  const idleSession = await idleConnection.openSession(DATABASE_V2_SCOPE_ALPHA);
  await idleConnection.close();
  await assertDatabaseConnectorV2Error(
    () => idleSession.bundles.channels(),
    "SESSION_CLOSED",
    "lifecycle",
  );

  const raceSubject = await harness.createSubject("lifecycle");
  const raceConnection = await raceSubject.connector.connect();
  const raceSession = await raceConnection.openSession(DATABASE_V2_SCOPE_ALPHA);
  raceSubject.faults.holdNextCommit();
  const activeCommit = raceSession.applyChangeSet(
    createDatabaseV2PutChangeSet(DATABASE_V2_CHANGE_SET_IDS.concurrentA, [
      bundle,
    ]),
  );
  await raceSubject.faults.waitForHeldCommit();
  const connectionClose = raceConnection.close();
  const closeState = await Promise.race([
    connectionClose,
    Promise.resolve("pending" as const),
  ]);
  assertDatabaseConnectorV2(
    closeState === "pending",
    "lifecycle-close-wait",
    "connection close must remain pending while a child commit is active",
  );
  raceSubject.faults.releaseHeldCommit();
  const [receipt] = await Promise.all([activeCommit, connectionClose]);
  assertDatabaseConnectorV2(
    receipt.outcome === "committed",
    "lifecycle",
    "close must wait for the active commit rather than cancel or race it",
  );
  await assertDatabaseConnectorV2Error(
    () => raceSession.bundles.get(bundle.id),
    "SESSION_CLOSED",
    "lifecycle",
  );
}
