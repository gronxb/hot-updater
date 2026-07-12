import { describe, expect, it } from "vitest";

import { expectConnectorErrorCode } from "./sessionRuntime.testAssertions";
import {
  CHANGE_SET_IDS,
  createRuntimeBundle,
  createRuntimeChangeSet,
  createRuntimeScope,
} from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type { MutableScopeFixture } from "./sessionRuntime.testTypes";

describe("database-v2 commit runtime", () => {
  const createSubject = setupRuntimeTestHarness();

  it("rejects malformed normalized changes before backend I/O", async () => {
    // Given malformed IDs, empty changes, duplicates, and empty revisions
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const bundle = createRuntimeBundle("bundle-a");
    const malformed = [
      {
        id: "not-a-uuid",
        changes: [
          { type: "put", value: bundle, precondition: { state: "absent" } },
        ],
      },
      { id: CHANGE_SET_IDS.first, changes: [] },
      {
        id: CHANGE_SET_IDS.first,
        changes: [
          { type: "put", value: bundle, precondition: { state: "absent" } },
          { type: "put", value: bundle, precondition: { state: "absent" } },
        ],
      },
      {
        id: CHANGE_SET_IDS.first,
        changes: [
          {
            type: "put",
            value: bundle,
            precondition: { state: "revision", revision: "" },
          },
        ],
      },
    ] as const;

    // When each malformed change set is submitted
    for (const changeSet of malformed) {
      await expectConnectorErrorCode(
        () => session.applyChangeSet(changeSet),
        "INVALID_CHANGE_SET",
      );
    }

    // Then none reaches the backend commit seam
    expect(backend.commitAttempts).toBe(0);
  });

  it("rejects concurrent commit B before a second backend call", async () => {
    // Given commit A held after it enters the backend
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const entered = backend.holdNextCommit();
    const commitA = session.applyChangeSet(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
    );
    await entered;
    const attemptsDuringA = backend.commitAttempts;

    // When commit B is submitted on the same session
    await expectConnectorErrorCode(
      () =>
        session.applyChangeSet(
          createRuntimeChangeSet(
            CHANGE_SET_IDS.second,
            "018f12ab-1234-7abc-8def-000000000002",
          ),
        ),
      "CONCURRENT_COMMIT",
    );

    // Then B causes zero backend I/O and A completes after release
    expect(backend.commitAttempts).toBe(attemptsDuringA);
    backend.releaseCommit();
    await expect(commitA).resolves.toMatchObject({ outcome: "committed" });
  });

  it("snapshots an active change set before caller mutation", async () => {
    // Given a mutable change set whose backend commit will be held
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    const bundle = createRuntimeBundle("018f12ab-1234-7abc-8def-000000000001");
    const changeSet = {
      id: String(CHANGE_SET_IDS.first),
      changes: [
        {
          type: "put" as const,
          value: bundle,
          precondition: { state: "absent" as const },
        },
      ],
    };
    const entered = backend.holdNextCommit();

    // When commit starts and the caller immediately mutates its objects
    const commit = session.applyChangeSet(changeSet);
    changeSet.id = CHANGE_SET_IDS.second;
    changeSet.changes[0].value.message = "mutated-after-call";
    await entered;

    // Then the backend sees only the immutable snapshot from call time
    expect(backend.observedCommits[0]?.changeSet.id).toBe(CHANGE_SET_IDS.first);
    expect(backend.observedCommits[0]?.changeSet.changes[0]).toMatchObject({
      value: { message: "018f12ab-1234-7abc-8def-000000000001" },
    });
    backend.releaseCommit();
    await expect(commit).resolves.toMatchObject({
      changeSetId: CHANGE_SET_IDS.first,
      outcome: "committed",
    });
  });

  it("keeps an ordinary rejected conflict readable and unpoisoned", async () => {
    // Given a backend that definitively rejects the next attempt
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    backend.enqueue({ kind: "rejected" });

    // When the change set receives a definitive conflict
    const receipt = await session.applyChangeSet(
      createRuntimeChangeSet(CHANGE_SET_IDS.first),
    );

    // Then the rejection is returned and reads remain available
    expect(receipt).toMatchObject({ outcome: "rejected", reason: "conflict" });
    await expect(session.bundles.channels()).resolves.toEqual([]);
  });
});
