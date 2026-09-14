import { describe, expect, it } from "vitest";

import type { GenerationEventsSnapshot } from "../../examples/lynx/src/e2eApp/generationEvents";
import { GenerationEventLedger } from "./generation-event-ledger";

const snapshot = (
  first: number,
  last: number,
  truncated: boolean,
): GenerationEventsSnapshot => ({
  schemaVersion: 1,
  oldestSequence: String(first),
  latestSequence: String(last),
  truncated,
  events: Array.from({ length: last - first + 1 }, (_, index) => ({
    sequence: String(first + index),
    name: "event",
    details: { value: first + index },
  })),
});

describe("generation event external ledger", () => {
  it("bridges a sticky truncated snapshot with byte-identical overlap", () => {
    const ledger = new GenerationEventLedger();
    ledger.merge("initial", snapshot(1, 256, false));
    ledger.merge("evicted", snapshot(2, 257, true));
    expect(ledger.receipt()).toMatchObject({
      oldestSequence: "1",
      latestSequence: "257",
      eventCount: 257,
      checkpoints: [{ truncated: false }, { truncated: true }],
    });
  });

  it("fails closed when truncation creates a gap", () => {
    const ledger = new GenerationEventLedger();
    ledger.merge("initial", snapshot(1, 10, false));
    expect(() => ledger.merge("gap", snapshot(12, 20, true))).toThrow(
      "hid a sequence gap",
    );
  });

  it("fails closed when overlapping native evidence changes", () => {
    const ledger = new GenerationEventLedger();
    ledger.merge("initial", snapshot(1, 10, false));
    const changed = snapshot(10, 11, true);
    (changed.events[0]!.details as { value: number }).value = 999;
    expect(() => ledger.merge("changed", changed)).toThrow("changed bytes");
  });
});
