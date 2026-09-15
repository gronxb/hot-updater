import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type AndroidRuntimeJournalEvidence,
  evaluateFontDiagnosticRecoveryByAndroidJournal,
  formatAndroidRuntimeJournalRecoveryDiagnostic,
  isFontDiagnosticRecoveredByAndroidJournal,
} from "./android-runtime-journal.ts";

type CapturedJournal = {
  events: Array<{
    details: Record<string, unknown>;
    name: string;
    sequence: string;
  }>;
  nextSequence: string;
  schemaVersion: number;
  truncated: boolean;
};

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/hkmqe0",
);

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureRoot, name), "utf8").trimEnd();
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function contractEnvelope(
  journalSource: string,
  overrides: Partial<AndroidRuntimeJournalEvidence> = {},
): AndroidRuntimeJournalEvidence {
  const journal = JSON.parse(journalSource) as CapturedJournal;
  const first = journal.events[0];
  const last = journal.events.at(-1);
  const ready = [...journal.events]
    .reverse()
    .find((event) => event.name === "jsReady");
  if (!first || !last || !ready) throw new Error("invalid fixture journal");
  const receipt = `generation-events -> ${last.sequence}`;
  return {
    actionResultResponse: { updateActionResult: receipt },
    currentProcessId: String(ready.details.processId),
    expectedLaunchGeneration: "fixture-contract-launch",
    expectedRuntimeScenarioMarker: "fixture-contract-marker",
    runtimeJournalUtf8: journalSource,
    screenStateResponse: {
      launchGeneration: "fixture-contract-launch",
      screenState: {
        currentBundleId: ready.details.bundleId,
        currentReleaseId: ready.details.releaseId,
        generationEvents: JSON.stringify({
          events: journal.events,
          latestSequence: last.sequence,
          oldestSequence: first.sequence,
          schemaVersion: 1,
          truncated: journal.truncated,
        }),
        launchStatus: "Current Launch Status: UNCHANGED",
        runtimeScenarioMarker: "fixture-contract-marker",
        updateActionResult: receipt,
      },
    },
    ...overrides,
  };
}

function mutatedEvidence(
  source: string,
  mutate: (journal: CapturedJournal) => void,
): AndroidRuntimeJournalEvidence {
  const journal = JSON.parse(source) as CapturedJournal;
  mutate(journal);
  journal.events.forEach((event, index) => {
    event.sequence = String(index + 1);
  });
  journal.nextSequence = String(journal.events.length + 1);
  return contractEnvelope(canonical(journal));
}

function rejectionCode(
  evidence: AndroidRuntimeJournalEvidence,
  pathName = "assets/probe.ttf",
): string {
  const result = evaluateFontDiagnosticRecoveryByAndroidJournal(
    pathName,
    evidence,
  );
  expect(isFontDiagnosticRecoveredByAndroidJournal(pathName, evidence)).toBe(
    false,
  );
  if (result.recovered) throw new Error("expected rejection");
  return result.rejection.code;
}

describe("Android runtime journal recovery diagnostics", () => {
  it.each(["UNCHANGED", "UPDATE_APPLIED", "RECOVERED"])(
    "accepts the public readiness status %s when the native journal confirms the running generation",
    (status) => {
      const evidence = contractEnvelope(
        fixture("android-s1-runtime-events.json"),
      );
      const screenStateResponse = evidence.screenStateResponse as {
        screenState: Record<string, unknown>;
      };
      screenStateResponse.screenState.launchStatus = `Current Launch Status: ${status}`;

      expect(
        evaluateFontDiagnosticRecoveryByAndroidJournal(
          "assets/probe.ttf",
          evidence,
        ),
      ).toEqual({ recovered: true });
    },
  );

  it("accepts ALREADY_CONFIRMED readiness for a previously confirmed running generation", () => {
    const evidence = mutatedEvidence(
      fixture("android-s1-runtime-events.json"),
      (journal) => {
        const ready = journal.events.find((event) => event.name === "jsReady");
        if (!ready) throw new Error("fixture is missing jsReady");
        ready.details.confirmation = { status: "ALREADY_CONFIRMED" };
      },
    );

    expect(
      evaluateFontDiagnosticRecoveryByAndroidJournal(
        "assets/probe.ttf",
        evidence,
      ),
    ).toEqual({ recovered: true });
  });

  it("rejects readiness that is not durably confirmed", () => {
    const evidence = mutatedEvidence(
      fixture("android-s1-runtime-events.json"),
      (journal) => {
        const ready = journal.events.find((event) => event.name === "jsReady");
        if (!ready) throw new Error("fixture is missing jsReady");
        ready.details.confirmation = { status: "PAGE_ADMITTED" };
      },
    );

    expect(rejectionCode(evidence)).toBe("screen.confirmed-ready-identity");
  });

  it("rejects a nonterminal public readiness status", () => {
    const evidence = contractEnvelope(
      fixture("android-s1-runtime-events.json"),
    );
    const screenStateResponse = evidence.screenStateResponse as {
      screenState: Record<string, unknown>;
    };
    screenStateResponse.screenState.launchStatus =
      "Current Launch Status: PENDING";

    expect(rejectionCode(evidence)).toBe("screen.launch-status");
  });

  it.each([
    [
      "android-s1",
      "android-s1-runtime-events.json",
      "android-s1-eligible.log",
      "9b28d166d78e69f1d42da081d02a8c423f96062af2e282b15e916ba0263ffb42",
      "e352ca97f6901f168efc86a9b770b5059bedf6b2473ecd3abe09f773ce439958",
    ],
    [
      "android-s2",
      "android-s2-runtime-events.json",
      "android-s2-eligible.log",
      "81e28642f944b6dfa89d193e4ae9add2c94e9ad894909c261021c042e80e8421",
      "f02345e6bc5b5899623d081cb6244d2f32558575f896f1bba61a1bddfa2df103",
    ],
  ])(
    "recovers the exact hkmqe0 %s native chain under the documented evidence envelope",
    (_label, journalName, logName, journalSha, logSha) => {
      const journal = fixture(journalName);
      const log = fixture(logName);
      expect(crypto.createHash("sha256").update(journal).digest("hex")).toBe(
        journalSha,
      );
      expect(crypto.createHash("sha256").update(log).digest("hex")).toBe(
        logSha,
      );
      expect(log).toContain("engine-error fatal=false code=302");
      expect(
        evaluateFontDiagnosticRecoveryByAndroidJournal(
          "assets/probe.ttf",
          contractEnvelope(journal),
        ),
      ).toEqual({ recovered: true });
      expect(
        isFontDiagnosticRecoveredByAndroidJournal(
          "assets/probe.ttf",
          contractEnvelope(journal),
        ),
      ).toBe(true);
    },
  );

  it.each([
    [
      "empty journal",
      () =>
        contractEnvelope(fixture("android-s1-runtime-events.json"), {
          runtimeJournalUtf8: "",
        }),
      "journal.empty",
    ],
    [
      "invalid journal JSON",
      () =>
        contractEnvelope(fixture("android-s1-runtime-events.json"), {
          runtimeJournalUtf8: "{",
        }),
      "journal.invalid-json",
    ],
    [
      "noncanonical journal",
      () => {
        const source = fixture("android-s1-runtime-events.json");
        return contractEnvelope(source, { runtimeJournalUtf8: `${source} ` });
      },
      "journal.noncanonical-json",
    ],
    [
      "action shape",
      () =>
        contractEnvelope(fixture("android-s1-runtime-events.json"), {
          actionResultResponse: {
            screenState: {},
            updateActionResult: "generation-events -> 16",
          },
        }),
      "screen.action-keys",
    ],
    [
      "launch generation",
      () => {
        const evidence = contractEnvelope(
          fixture("android-s1-runtime-events.json"),
        );
        return { ...evidence, expectedLaunchGeneration: "other-launch" };
      },
      "screen.launch-generation-mismatch",
    ],
    [
      "runtime marker",
      () =>
        contractEnvelope(fixture("android-s1-runtime-events.json"), {
          expectedRuntimeScenarioMarker: "other-marker",
        }),
      "screen.runtime-marker-mismatch",
    ],
    [
      "wait receipt",
      () =>
        contractEnvelope(fixture("android-s1-runtime-events.json"), {
          actionResultResponse: {
            updateActionResult: "generation-events -> 15",
          },
        }),
      "screen.wait-action-receipt",
    ],
    [
      "truncated parity",
      () => {
        const evidence = contractEnvelope(
          fixture("android-s1-runtime-events.json"),
        );
        const response = structuredClone(evidence.screenStateResponse) as {
          screenState: { generationEvents: string };
        };
        response.screenState.generationEvents = JSON.stringify({
          ...(JSON.parse(response.screenState.generationEvents) as object),
          truncated: true,
        });
        return { ...evidence, screenStateResponse: response };
      },
      "evidence.truncated-mismatch",
    ],
    [
      "journal next sequence",
      () => {
        const source = fixture("android-s1-runtime-events.json");
        const journal = JSON.parse(source) as CapturedJournal;
        journal.nextSequence = "18";
        return contractEnvelope(canonical(journal));
      },
      "journal.next-sequence-event-mismatch",
    ],
    [
      "screen and journal events",
      () => {
        const evidence = contractEnvelope(
          fixture("android-s1-runtime-events.json"),
        );
        const response = structuredClone(evidence.screenStateResponse) as {
          screenState: { generationEvents: string };
        };
        const snapshot = JSON.parse(response.screenState.generationEvents) as {
          events: CapturedJournal["events"];
        };
        snapshot.events[0].details.primary = false;
        response.screenState.generationEvents = JSON.stringify(snapshot);
        return { ...evidence, screenStateResponse: response };
      },
      "evidence.canonical-events-mismatch",
    ],
  ])("reports %s as %s", (_label, evidence, expected) => {
    expect(rejectionCode(evidence())).toBe(expected);
  });

  it.each([
    ["runtimeId", "runtime-other"],
    ["processId", "99999"],
    ["generationId", "generation-other"],
    ["contextId", "context-other"],
    ["attemptId", "attempt-other"],
    ["pageAttemptId", "page-attempt-other"],
    ["transitionId", "transition-other"],
    ["bundleId", "bundle-other"],
    ["releaseId", "release-other"],
  ])("identifies diagnostic %s identity drift", (field, value) => {
    const source = fixture("android-s1-runtime-events.json");
    const evidence = mutatedEvidence(source, (journal) => {
      journal.events.find(
        (event) => event.name === "engineDiagnostic",
      )!.details[field] = value;
    });
    const result = evaluateFontDiagnosticRecoveryByAndroidJournal(
      "assets/probe.ttf",
      evidence,
    );
    expect(result).toEqual({
      recovered: false,
      rejection: expect.objectContaining({
        code: "diagnostic.identity-mismatch",
        field,
      }),
    });
  });

  it.each([
    [
      "missing diagnostic",
      (journal: CapturedJournal) => {
        journal.events = journal.events.filter(
          (event) => event.name !== "engineDiagnostic",
        );
      },
      "diagnostic.missing",
    ],
    [
      "duplicate diagnostic",
      (journal: CapturedJournal) => {
        const diagnostic = structuredClone(
          journal.events.find((event) => event.name === "engineDiagnostic")!,
        );
        journal.events.splice(
          journal.events.findIndex((event) => event.name === "fontLoaded"),
          0,
          diagnostic,
        );
      },
      "diagnostic.count",
    ],
    [
      "diagnostic before start",
      (journal: CapturedJournal) => {
        const index = journal.events.findIndex(
          (event) => event.name === "engineDiagnostic",
        );
        const [diagnostic] = journal.events.splice(index, 1);
        journal.events.splice(
          journal.events.findIndex(
            (event) => event.name === "generationStarted",
          ),
          0,
          diagnostic,
        );
      },
      "order.diagnostic-before-started",
    ],
    [
      "missing generation start",
      (journal: CapturedJournal) => {
        journal.events = journal.events.filter(
          (event) => event.name !== "generationStarted",
        );
      },
      "order.started-missing",
    ],
    [
      "font path drift",
      (journal: CapturedJournal) => {
        journal.events.find(
          (event) => event.name === "fontLoaded",
        )!.details.path = "assets/other.ttf";
      },
      "font.path-mismatch",
    ],
    [
      "font digest drift",
      (journal: CapturedJournal) => {
        journal.events.find(
          (event) => event.name === "fontLoaded",
        )!.details.sha256 = "invalid";
      },
      "font.sha256-invalid",
    ],
    [
      "fatal boundary",
      (journal: CapturedJournal) => {
        const readyIndex = journal.events.findIndex(
          (event) => event.name === "jsReady",
        );
        journal.events.splice(readyIndex, 0, {
          details: structuredClone(journal.events[readyIndex].details),
          name: "generationFailed",
          sequence: "0",
        });
      },
      "order.fatal-before-ready",
    ],
    [
      "new generation after readiness",
      (journal: CapturedJournal) => {
        journal.events.push({
          details: structuredClone(journal.events.at(-1)!.details),
          name: "generationWillEvaluate",
          sequence: "0",
        });
      },
      "order.generation-boundary-after-ready",
    ],
  ])("reports %s as %s", (_label, mutate, expected) => {
    expect(
      rejectionCode(
        mutatedEvidence(fixture("android-s1-runtime-events.json"), mutate),
      ),
    ).toBe(expected);
  });

  it.each([
    ["fatal", true],
    ["code", 301],
    ["subcode", 30202],
    ["type", "image"],
    ["path", "assets/other.ttf"],
  ])("identifies diagnostic %s drift", (field, value) => {
    const evidence = mutatedEvidence(
      fixture("android-s1-runtime-events.json"),
      (journal) => {
        journal.events.find(
          (event) => event.name === "engineDiagnostic",
        )!.details[field] = value;
      },
    );
    const result = evaluateFontDiagnosticRecoveryByAndroidJournal(
      "assets/probe.ttf",
      evidence,
    );
    expect(result).toEqual({
      recovered: false,
      rejection: expect.objectContaining({
        code: "diagnostic.field-mismatch",
        field,
      }),
    });
  });

  it("formats only bounded shapes, identifiers, counts, and hashes", () => {
    const evidence = contractEnvelope(
      fixture("android-s1-runtime-events.json"),
      {
        actionResultResponse: {
          secret: "https://credentials.example/private?token=do-not-print",
          updateActionResult: "unexpected private response body",
        },
      },
    );
    const result = evaluateFontDiagnosticRecoveryByAndroidJournal(
      "assets/probe.ttf",
      evidence,
    );
    const diagnostic = formatAndroidRuntimeJournalRecoveryDiagnostic(
      evidence,
      result,
    );
    expect(diagnostic).toContain("reason=screen.action-keys");
    expect(diagnostic).toContain("keys=[sha256:");
    expect(diagnostic).toContain("updateActionResult");
    expect(diagnostic).toContain("journal={bytes=");
    expect(diagnostic).toContain("events=16 first=1 last=16 next=17");
    expect(diagnostic).not.toContain("credentials.example");
    expect(diagnostic).not.toContain("do-not-print");
    expect(diagnostic).not.toContain("unexpected private response body");
  });

  it("never discloses token-like identifiers, markers, rejection fields, or codes", () => {
    const secret = "BearerSecretABC123";
    const evidence = contractEnvelope(
      fixture("android-s1-runtime-events.json"),
      {
        actionResultResponse: {
          [secret]: secret,
          updateActionResult: secret,
        },
        currentProcessId: secret,
        expectedLaunchGeneration: secret,
        expectedRuntimeScenarioMarker: secret,
        screenStateResponse: {
          launchGeneration: secret,
          screenState: {
            currentBundleId: secret,
            currentReleaseId: secret,
            generationEvents: secret,
            launchStatus: secret,
            runtimeScenarioMarker: secret,
            updateActionResult: secret,
          },
        },
      },
    );
    const result = {
      recovered: false,
      rejection: { code: secret, field: secret, sequence: secret },
    } as unknown as Parameters<
      typeof formatAndroidRuntimeJournalRecoveryDiagnostic
    >[1];

    const diagnostic = formatAndroidRuntimeJournalRecoveryDiagnostic(
      evidence,
      result,
    );

    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toMatch(/reason=sha256:[0-9a-f]{64}/);
    expect(diagnostic.length).toBeLessThanOrEqual(4096);
  });

  it.each([
    ["missing rejection", { recovered: false }, "rejection.malformed"],
    [
      "null rejection",
      { recovered: false, rejection: null },
      "rejection.malformed",
    ],
    ["invalid discriminator", { recovered: "false" }, "result.malformed"],
  ])(
    "does not throw for a malformed %s result",
    (_label, malformed, reason) => {
      const evidence = contractEnvelope(
        fixture("android-s1-runtime-events.json"),
        { runtimeJournalUtf8: undefined as unknown as string },
      );

      let diagnostic = "";
      expect(() => {
        diagnostic = formatAndroidRuntimeJournalRecoveryDiagnostic(
          evidence,
          malformed as unknown as Parameters<
            typeof formatAndroidRuntimeJournalRecoveryDiagnostic
          >[1],
        );
      }).not.toThrow();
      expect(diagnostic).toContain(`reason=${reason}`);
      expect(diagnostic).toContain("journal={type=undefined}");
    },
  );

  it("summarizes cyclic objects and unbounded sequence values without throwing", () => {
    const hugeSequence = "9".repeat(20_000);
    const journal = JSON.parse(
      fixture("android-s1-runtime-events.json"),
    ) as CapturedJournal;
    const firstJournalSequence = BigInt("9".repeat(64));
    journal.events.forEach((event, index) => {
      event.sequence = (firstJournalSequence + BigInt(index)).toString();
    });
    journal.nextSequence = (
      firstJournalSequence + BigInt(journal.events.length)
    ).toString();
    journal.truncated = true;
    const cyclic: Record<string, unknown> = {
      generationEvents: JSON.stringify({
        events: [
          { sequence: hugeSequence },
          { sequence: `invalid-${hugeSequence}` },
        ],
        latestSequence: hugeSequence,
        oldestSequence: `invalid-${hugeSequence}`,
        truncated: false,
      }),
      updateActionResult: `generation-events -> ${hugeSequence}`,
    };
    cyclic.screenState = cyclic;
    const evidence = {
      actionResultResponse: cyclic,
      currentProcessId: "BearerSecretABC123",
      expectedLaunchGeneration: "BearerSecretABC123",
      expectedRuntimeScenarioMarker: "BearerSecretABC123",
      runtimeJournalUtf8: canonical(journal),
      screenStateResponse: cyclic,
    } as unknown as AndroidRuntimeJournalEvidence;
    const result = {
      recovered: false,
      rejection: {
        code: "diagnostic.identity-mismatch",
        sequence: hugeSequence,
      },
    } as const;

    let diagnostic = "";
    expect(() => {
      diagnostic = formatAndroidRuntimeJournalRecoveryDiagnostic(
        evidence,
        result,
      );
    }).not.toThrow();
    expect(diagnostic).toContain("reason=diagnostic.identity-mismatch");
    expect(diagnostic).toMatch(
      /journal=\{bytes=.+ events=16 first=sha256:[0-9a-f]{64} last=sha256:[0-9a-f]{64} next=sha256:[0-9a-f]{64}/,
    );
    expect(diagnostic).not.toContain(hugeSequence);
    expect(diagnostic).not.toContain(firstJournalSequence.toString());
    expect(diagnostic.length).toBeLessThanOrEqual(4096);
  });
});
