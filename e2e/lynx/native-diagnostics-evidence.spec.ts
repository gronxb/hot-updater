import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  validateNavigationStackBoundary,
  validateRuntimeJournalDiagnostics,
} from "./native-diagnostics-evidence";

const event = (sequence: number) => ({
  sequence: String(sequence),
  name: "fixture",
  details: {},
});

const receipt = (
  events: readonly unknown[],
  truncated: boolean,
  canonicalUtf8: string | null = null,
) => {
  const bytes = Buffer.from(
    canonicalUtf8 ??
      JSON.stringify({
        events,
        nextSequence: "1",
        schemaVersion: 1,
        truncated,
      }),
  );
  return {
    snapshot: {
      schemaVersion: 1,
      oldestSequence:
        events.length === 0
          ? null
          : (events[0] as { sequence: string }).sequence,
      latestSequence:
        events.length === 0
          ? null
          : (events.at(-1) as { sequence: string }).sequence,
      truncated,
      events,
    },
    byteLength: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    canonicalUtf8,
  };
};

const repair =
  '{"events":[],"nextSequence":"1","schemaVersion":1,"truncated":true}';

function validJournalEvidence() {
  return {
    fixtures: {
      "retention-limit": receipt(
        Array.from({ length: 256 }, (_, index) => event(index + 1)),
        false,
      ),
      "count-plus-one": receipt(
        Array.from({ length: 256 }, (_, index) => event(index + 2)),
        true,
      ),
      "byte-plus-one": receipt(
        Array.from({ length: 255 }, (_, index) => event(index + 2)),
        true,
      ),
      "corrupt-json": receipt([], true, repair),
      noncanonical: receipt([], true, repair),
      "already-oversized": receipt([], true, repair),
    },
    appended: receipt(
      Array.from({ length: 256 }, (_, index) => event(index + 2)),
      true,
    ),
    eventFields: {
      exactNameAccepted: true,
      namePlusOneRejected: true,
      exactDetailsAccepted: true,
      detailsPlusOneRejected: true,
      beforeLatestSequence: "257",
      afterLatestSequence: "259",
      acceptedSequenceCount: 2,
    },
  };
}

describe("native Lynx diagnostics evidence", () => {
  it("accepts the exact retention, repair, and event-field boundary receipt", () => {
    expect(() =>
      validateRuntimeJournalDiagnostics(validJournalEvidence()),
    ).not.toThrow();
  });

  it("rejects an old count-overflow false positive that did not evict", () => {
    const evidence = validJournalEvidence();
    evidence.appended.snapshot.oldestSequence = "1";
    expect(() => validateRuntimeJournalDiagnostics(evidence)).toThrow(
      "retained suffix",
    );
  });

  it("rejects repair receipts whose bytes are not canonical", () => {
    const evidence = validJournalEvidence();
    evidence.fixtures.noncanonical = receipt([], true, `${repair}\n`);
    expect(() => validateRuntimeJournalDiagnostics(evidence)).toThrow(
      "canonical repair bytes",
    );
  });

  it("requires native and logical stack immutability at depth 17", () => {
    const stack = {
      acceptedDepths: Array.from({ length: 15 }, (_, index) => index + 2),
      acceptedContextIds: Array.from(
        { length: 15 },
        (_, index) => `context-${index}`,
      ),
      rejectionCode: "STACK_LIMIT_EXCEEDED",
      before: {},
      beforeRejected: {
        orderedPageEntries: Array.from({ length: 16 }, (_, index) =>
          index === 0 ? "main.lynx.bundle" : "detail.lynx.bundle",
        ),
        orderedPageParameters: Array.from({ length: 16 }, () => []),
        topPageEntry: "detail.lynx.bundle",
        topContextId: "context-14",
      },
      afterRejected: null as unknown,
      nativeDepthBeforeRejected: 16,
      nativeDepthAfterRejected: 16,
    };
    stack.afterRejected = structuredClone(stack.beforeRejected);
    expect(() => validateNavigationStackBoundary(stack)).not.toThrow();
    stack.nativeDepthAfterRejected = 17;
    expect(() => validateNavigationStackBoundary(stack)).toThrow("mutated");
  });
});
