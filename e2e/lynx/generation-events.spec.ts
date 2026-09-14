import { describe, expect, it, vi } from "vitest";

import {
  readGenerationEvents,
  validateGenerationEventsSnapshot,
} from "../../examples/lynx/src/e2eApp/generationEvents";

const event = (sequence: string) => ({
  sequence,
  name: "pageAdmitted",
  details: {
    runtimeId: "runtime",
    processId: "123",
    generationId: "generation-b",
    bundleId: "bundle-b",
    releaseId: "release-b",
    contextId: "context-detail-b",
    pageAttemptId: "page-attempt-b",
    transitionId: null,
    pageEntry: "detail.lynx.bundle",
  },
});

const snapshot = (events = [event("4"), event("5")]) => ({
  schemaVersion: 1,
  oldestSequence: events.at(0)?.sequence ?? null,
  latestSequence: events.at(-1)?.sequence ?? null,
  truncated: false,
  events,
});

describe("Lynx generation event snapshots", () => {
  it("accepts authentic ordered events after the requested cursor", async () => {
    const getRuntimeEvents = vi.fn(async () => snapshot());

    await expect(
      readGenerationEvents({ getRuntimeEvents }),
    ).resolves.toMatchObject({
      latestSequence: "5",
    });
    expect(getRuntimeEvents).toHaveBeenCalledWith();
  });

  it("rejects replayed, unordered, or fabricated event identities", () => {
    expect(() =>
      validateGenerationEventsSnapshot(snapshot([event("4"), event("4")])),
    ).toThrow("strictly ordered");
    expect(() =>
      validateGenerationEventsSnapshot(
        snapshot([{ ...event("4"), details: "detail ready" }]),
      ),
    ).toThrow("generation events[0].details must be an object");
    expect(() =>
      validateGenerationEventsSnapshot(
        snapshot([
          {
            ...event("4"),
            details: { ...event("4").details, processId: "01" },
          },
        ]),
      ),
    ).toThrow("processId must be a canonical positive decimal string");
    const missingTransition = { ...event("4").details };
    delete (missingTransition as { transitionId?: unknown }).transitionId;
    expect(() =>
      validateGenerationEventsSnapshot(
        snapshot([{ ...event("4"), details: missingTransition }]),
      ),
    ).toThrow("transitionId must be present");
  });

  it("rejects obsolete or invented page-attempt terminal states", () => {
    for (const terminal of ["fatal", "interrupted", "cancelled"]) {
      expect(() =>
        validateGenerationEventsSnapshot(
          snapshot([
            {
              ...event("4"),
              name: "pageAttemptTerminal",
              details: { ...event("4").details, terminal },
            },
          ]),
        ),
      ).toThrow(
        "must be admitted, verified-fatal, authorized-cancel, or process-interruption",
      );
    }
  });

  it("requires the complete canonical engine diagnostic projection", () => {
    const diagnostic = {
      ...event("4"),
      name: "engineDiagnostic",
      details: {
        ...event("4").details,
        attemptId: "attempt-b",
        fatal: false,
        code: 302,
        subcode: 30201,
        type: "font",
        path: "assets/probe.ttf",
      },
    };
    expect(() =>
      validateGenerationEventsSnapshot(snapshot([diagnostic])),
    ).not.toThrow();
    for (const details of [
      { ...diagnostic.details, attemptId: null },
      { ...diagnostic.details, code: 302.5 },
      { ...diagnostic.details, path: "assets/../probe.ttf" },
      { ...diagnostic.details, path: "a".repeat(1_025) },
    ]) {
      expect(() =>
        validateGenerationEventsSnapshot(
          snapshot([{ ...diagnostic, details }]),
        ),
      ).toThrow("invalid engine diagnostic");
    }
  });

  it("rejects truncated or incompatible journal shapes instead of guessing", () => {
    expect(() =>
      validateGenerationEventsSnapshot({ ...snapshot(), truncated: true }),
    ).toThrow("generation events were truncated before collection");
    expect(() =>
      validateGenerationEventsSnapshot({ ...snapshot(), schemaVersion: 2 }),
    ).toThrow("generation events snapshot schemaVersion must be 1");
    expect(() =>
      validateGenerationEventsSnapshot({ ...snapshot(), latestSequence: "2" }),
    ).toThrow("generation events sequence bounds are reversed");
  });
});
