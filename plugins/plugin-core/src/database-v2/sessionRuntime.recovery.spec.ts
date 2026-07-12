import { describe, expect, it } from "vitest";

import { expectConnectorErrorCode } from "./sessionRuntime.testAssertions";
import {
  CHANGE_SET_IDS,
  createRuntimeChangeSet,
  createRuntimeScope,
} from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

describe("database-v2 unknown-outcome recovery", () => {
  const createSubject = setupRuntimeTestHarness();

  it("allows only exact retry after unknown and unpoisons on commit", async () => {
    // Given an unknown-before-write result for one exact change identity
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
    backend.enqueue({ kind: "unknown-before" });
    const unknown = await session.applyChangeSet(changeSet);

    // When poisoned reads and a different commit are attempted
    await expectConnectorErrorCode(
      () => session.bundles.get("bundle-a"),
      "SESSION_POISONED",
    );
    await expectConnectorErrorCode(
      () =>
        session.applyChangeSet(createRuntimeChangeSet(CHANGE_SET_IDS.second)),
      "SESSION_POISONED",
    );

    // Then only the exact retry commits and restores reads
    expect(unknown).toMatchObject({
      outcome: "unknown",
      sessionState: "poisoned",
    });
    await expect(session.applyChangeSet(changeSet)).resolves.toMatchObject({
      outcome: "committed",
    });
    await expect(session.bundles.get("bundle-a")).resolves.toBeNull();
  });

  it("keeps repeated unknown poisoned until a definitive retry", async () => {
    // Given two scripted unknown outcomes for the exact same retry
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
    backend.enqueue({ kind: "unknown-before" });
    backend.enqueue({ kind: "unknown-repeated" });

    // When both exact attempts return unknown
    const first = await session.applyChangeSet(changeSet);
    const second = await session.applyChangeSet(changeSet);

    // Then the session remains poisoned until a third definitive attempt
    expect(first.outcome).toBe("unknown");
    expect(second.outcome).toBe("unknown");
    await expectConnectorErrorCode(
      () => session.bundles.channels(),
      "SESSION_POISONED",
    );
    await expect(session.applyChangeSet(changeSet)).resolves.toMatchObject({
      outcome: "committed",
    });
    await expect(session.bundles.channels()).resolves.toEqual([]);
  });

  it("rejects a same-ID different-payload retry without backend I/O", async () => {
    // Given an unknown change set and a retry that reuses only its ID
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const original = createRuntimeChangeSet(CHANGE_SET_IDS.first);
    backend.enqueue({ kind: "unknown-before" });
    await session.applyChangeSet(original);
    const attemptsAfterUnknown = backend.commitAttempts;
    const mismatched = createRuntimeChangeSet(
      CHANGE_SET_IDS.first,
      "018f12ab-1234-7abc-8def-000000000002",
    );

    // When the same ID is retried with a different payload
    await expectConnectorErrorCode(
      () => session.applyChangeSet(mismatched),
      "SESSION_POISONED",
    );

    // Then payload comparison fails closed before another backend attempt
    expect(backend.commitAttempts).toBe(attemptsAfterUnknown);
    await expectConnectorErrorCode(
      () => session.bundles.channels(),
      "SESSION_POISONED",
    );
  });

  it("unpoisons when an intervening tenant mutation makes recovery reject", async () => {
    // Given unknown-before-write followed by a definitive backend conflict
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
    backend.enqueue({ kind: "unknown-before" });
    await session.applyChangeSet(changeSet);
    backend.mutateTenantBeforeRecovery();

    // When the exact retry observes the intervening conflict
    const recovered = await session.applyChangeSet(changeSet);

    // Then the definitive rejection is returned and the session unpoisons
    expect(recovered).toMatchObject({
      outcome: "rejected",
      reason: "conflict",
    });
    expect(backend.interveningTenantMutations).toBe(1);
    await expect(session.bundles.channels()).resolves.toEqual([]);
  });

  it("discovers an after-durability receipt from a fresh session", async () => {
    // Given a backend that durably commits but reports unknown
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
    backend.enqueue({ kind: "unknown-after" });

    // When the poisoned session closes and a fresh session retries exactly
    await expect(session.applyChangeSet(changeSet)).resolves.toMatchObject({
      outcome: "unknown",
    });
    await session.close();
    const fresh = await connection.openSession(createRuntimeScope());
    const replay = await fresh.applyChangeSet(changeSet);

    // Then the durable receipt is replayed without another domain write
    expect(replay).toMatchObject({ outcome: "replayed" });
    expect(backend.receipts).toHaveLength(1);
  });

  it("rejects mismatched recovery identity and remains poisoned", async () => {
    // Given an unknown result followed by a backend identity mismatch
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
    backend.enqueue({ kind: "unknown-before" });
    backend.enqueue({ kind: "protocol-identity" });
    await session.applyChangeSet(changeSet);

    // When the exact recovery returns a mismatched identity
    await expectConnectorErrorCode(
      () => session.applyChangeSet(changeSet),
      "CONNECTOR_PROTOCOL_VIOLATION",
    );

    // Then the session remains poisoned
    await expectConnectorErrorCode(
      () => session.bundles.channels(),
      "SESSION_POISONED",
    );
  });

  it("rejects a mismatched recovery revision set and remains poisoned", async () => {
    // Given an unknown result followed by a committed receipt without revisions
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const changeSet = createRuntimeChangeSet(CHANGE_SET_IDS.first);
    backend.enqueue({ kind: "unknown-before" });
    backend.enqueue({ kind: "protocol-revisions" });
    await session.applyChangeSet(changeSet);

    // When exact recovery returns the incomplete revision set
    await expectConnectorErrorCode(
      () => session.applyChangeSet(changeSet),
      "CONNECTOR_PROTOCOL_VIOLATION",
    );

    // Then poison is preserved
    await expectConnectorErrorCode(
      () => session.bundles.get("bundle-a"),
      "SESSION_POISONED",
    );
  });
});
