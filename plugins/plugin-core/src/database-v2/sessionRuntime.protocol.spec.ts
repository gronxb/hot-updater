import { describe, expect, it } from "vitest";

import { expectConnectorErrorCode } from "./sessionRuntime.testAssertions";
import {
  CHANGE_SET_IDS,
  createRuntimeChangeSet,
  createRuntimeScope,
} from "./sessionRuntime.testFixtures";
import { setupRuntimeTestHarness } from "./sessionRuntime.testHarness";
import type {
  MutableScopeFixture,
  TestBackendCommitRequestV2,
} from "./sessionRuntime.testTypes";

const receiptIdentity = (request: TestBackendCommitRequestV2) => ({
  changeSetId: request.changeSet.id,
  scopeId: request.scope.scopeId,
  canonicalPayloadHash: request.canonicalPayloadHash,
});

const receiptCases: readonly {
  readonly label: string;
  readonly create: (request: TestBackendCommitRequestV2) => unknown;
}[] = [
  { label: "null", create: () => null },
  { label: "a primitive", create: () => 7 },
  {
    label: "an unknown outcome",
    create: (request) => ({ ...receiptIdentity(request), outcome: "future" }),
  },
  {
    label: "committed without revisions",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "committed",
    }),
  },
  {
    label: "committed with revision arrays",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "committed",
      revisions: ["revision-1"],
    }),
  },
  {
    label: "committed with empty revisions",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "committed",
      revisions: {
        "018f12ab-1234-7abc-8def-000000000001": "",
      },
    }),
  },
  {
    label: "committed with a contradictory reason",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "committed",
      reason: "conflict",
      revisions: {
        "018f12ab-1234-7abc-8def-000000000001": "revision-1",
      },
    }),
  },
  {
    label: "committed with an unsupported timestamp",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "committed",
      committedAt: "2026-07-11T00:00:00.000Z",
      revisions: {
        "018f12ab-1234-7abc-8def-000000000001": "revision-1",
      },
    }),
  },
  {
    label: "rejected with an unknown reason",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "rejected",
      reason: "later",
    }),
  },
  {
    label: "rejected with contradictory revisions",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "rejected",
      reason: "conflict",
      revisions: {},
    }),
  },
  {
    label: "unknown with the wrong reason",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "unknown",
      reason: "timeout",
      sessionState: "poisoned",
      retry: "identical-scope-id-and-payload-only",
    }),
  },
  {
    label: "unknown with the wrong state",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "unknown",
      reason: "transport-unknown",
      sessionState: "open",
      retry: "identical-scope-id-and-payload-only",
    }),
  },
  {
    label: "unknown with the wrong retry rule",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "unknown",
      reason: "transport-unknown",
      sessionState: "poisoned",
      retry: "always",
    }),
  },
  {
    label: "unknown with contradictory revisions",
    create: (request) => ({
      ...receiptIdentity(request),
      outcome: "unknown",
      reason: "transport-unknown",
      sessionState: "poisoned",
      retry: "identical-scope-id-and-payload-only",
      revisions: {},
    }),
  },
];

describe("database-v2 backend receipt boundary", () => {
  const createSubject = setupRuntimeTestHarness();

  for (const receiptCase of receiptCases) {
    it(`rejects ${receiptCase.label} as a protocol violation`, async () => {
      // Given a backend returning a malformed runtime receipt
      const { backend, connection } =
        createSubject<MutableScopeFixture["context"]>();
      const session = await connection.openSession(createRuntimeScope());
      backend.queueReceiptDefect(receiptCase.create);

      // When the receipt crosses the connector boundary
      await expectConnectorErrorCode(
        () =>
          session.applyChangeSet(createRuntimeChangeSet(CHANGE_SET_IDS.first)),
        "CONNECTOR_PROTOCOL_VIOLATION",
      );

      // Then ambiguous backend activity poisons the session
      await expectConnectorErrorCode(
        () => session.bundles.channels(),
        "SESSION_POISONED",
      );
    });
  }

  it("rejects receipt accessors without invoking them", async () => {
    // Given a backend receipt with an accessor at its discriminant
    const { backend, connection } =
      createSubject<MutableScopeFixture["context"]>();
    const session = await connection.openSession(createRuntimeScope());
    let getterCalls = 0;
    backend.queueReceiptDefect((request) => {
      const receipt = {
        ...receiptIdentity(request),
        outcome: "unknown",
        reason: "transport-unknown",
        sessionState: "poisoned",
        retry: "identical-scope-id-and-payload-only",
      };
      Object.defineProperty(receipt, "outcome", {
        configurable: true,
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "unknown";
        },
      });
      return receipt;
    });

    // When the receipt crosses the connector boundary
    await expectConnectorErrorCode(
      () =>
        session.applyChangeSet(createRuntimeChangeSet(CHANGE_SET_IDS.first)),
      "CONNECTOR_PROTOCOL_VIOLATION",
    );

    // Then inspection has no accessor side effects and poisons the session
    await expectConnectorErrorCode(
      () => session.bundles.channels(),
      "SESSION_POISONED",
    );
    expect(getterCalls).toBe(0);
  });
});
