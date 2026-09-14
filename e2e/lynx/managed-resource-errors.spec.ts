import crypto from "node:crypto";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  assertNoManagedResourceEngineErrors,
  findManagedResourceEngineErrorCodes,
} from "./managed-resource-errors";

const SHA = "a".repeat(64);
const YNQB7P_JOURNAL_GZIP_BASE64 =
  "H4sICAvpp2oCA3lucWI3cC1hbmRyb2lkLXMxLXJ1bnRpbWUtZXZlbnRzLmpzb24A7Zpfb9w2DMC/yz3Xrv5ZsvIWZBlQYFuDFtgeijxQEpU4s+WrLQcJgnz30ZdkabLb1iIFehfYD4ZliCZF/kTxpLtZ4SWmPK4OPt2sAmZoWnq+WUHO2K3zu7A6WFnO0WspClezWCioTFFH7gvLndFOG60YW71ZuSmFFjcS7P4qNjcz3+qH5sNFEr5PpDDhsBHyNbM8gi4c1LpQCmJhLZeFd8JpiFZKD/dCePVNlp0h6YDc9GkjpaOplDWxMLzCQlX0VKMMBVgVnFWKGx9JKpHEJZ7AGR61MI6zhX1Xnvd5WgfIOJTtdbrCK+jWLZbvMxx66t/kaxJdk9DhowfT1LZ3L49THq7pSx0NeyNf3nntXuYEBuiQvj3H4JbeDU0Hs0AeJpybvcdx3AzCaDsPbcAWYcRHLcOUctPdhQFSGPomFOMahj/bJp0VouQlKwZfclEkuBwH8pU00bBgvGRcQAXFbFYhS0sdZ/0XIzVqakC7PodSFx0kMjUUs8FjccnJijxAGpsHB8+G3M7+65CMeHT+H03bHl9CO5H3SGjEzxMmP/fhq9s3C367hx/k83/pvaskjucgKk0aKy+VM8I65kSwVlcURHI78xqliDXzyvhQkcstMIzeB8Wdp8iD1nX0yv4P1QOO/TR4/GUe86H/PDUDhqdQiwXqBer9hLqH8Jxm+app/ltkLoS+Tuj0B8yBfghIeebknvoGN+b+A+XTJz2/nACfbm5Pv3t5cvTt/t461WDsE7WbRHhCuzvFTb8++W/ffF358zHDkJ9PK7UsEju8SJB2zONbotVhuU5ne7FIRE/RUVU0tUSHgTGtow4MFJmrgqxo2QhgKETCSWudFy5orZWvDHcOpHl55VMtUC9Q7xXUtI6dbS179ILybm6M7OFOSGyGMW+KpZSfUmYWynY/Ybq+zyPFd11ejPvxa9GBisHWMpioOQQpFGVRUQGicFUMkaIXsUaoYrRBUD/mKH8iSowm1urlhUC9cL1wvbdcbykH7AL0DgMdrimEjX9L+td9olV27zb4RKiN4VEK4Rma2qlIVEd6tk4qZhhXQjAhlfVa1UaoEJQRFTeBVV5Q6F+esjlbEF8QfwWIb8nefDlnXDYmXsnGBF+OF/eG5ZzjXrDMHavRRC+0gcob5EFzxRmLmilHfBusgTkUikcWRV1HAKIavJWga+ngO1QfcqF6oXqvqI6EwdYE/cOO9mIzdBvIZqVjhjzNzBy9/+3ndx9+Pf7pyXgeQrR1hMu0eI3b0BfjB4Rw/YzWajX/MyBR5D5+8VbPvfw5dvA7DXrDC5+/PiUP81n2QYR2xNu/AJvNz2VGKgAA";
const YNQB7P_LOG = String.raw`09-14 20:30:41.275  7690  7719 I HotUpdaterLynx: engine-error fatal=false code=302 message={"error_code":302,"sub_code":30201,"error":"Src format is incorrect","sdk":"0.0.1","level":"error","consumers":[],"fix_suggestion":"Please check the font-face format.","src":"hot-updater:\/\/\/assets\/probe.ttf","type":"font"}`;
const YNQB7P_JOURNAL = gunzipSync(
  Buffer.from(YNQB7P_JOURNAL_GZIP_BASE64, "base64"),
).toString("utf8");
const identity = {
  runtimeId: "runtime-A",
  processId: "1234",
  generationId: "generation-A",
  contextId: "context-A",
  attemptId: "attempt-A",
  bundleId: "bundle-A",
  releaseId: "release-A",
};

type LogEnvelope = (message: string, processId?: string) => string;

function log(message: string, processId = "1234"): string {
  return `09-14 12:34:56.789  ${processId}  1234 I HotUpdaterLynx: ${message}`;
}

function briefLog(message: string, processId = "1234"): string {
  return `I/HotUpdaterLynx( ${processId}): ${message}`;
}

function matrixEvent(
  event: string,
  details: Record<string, unknown> = {},
  envelope: LogEnvelope = log,
): string {
  return envelope(
    `HOT_UPDATER_MATRIX_EVENT ${JSON.stringify({
      ...identity,
      pageAttemptId: null,
      transitionId: null,
      event,
      ...details,
    })}`,
  );
}

function engineError(
  overrides: Record<string, unknown> = {},
  fatal = false,
  envelope: LogEnvelope = log,
): string {
  return envelope(
    `engine-error fatal=${fatal} code=302 message=${JSON.stringify({
      error_code: 302,
      sub_code: 30201,
      error: "Src format is incorrect",
      type: "font",
      src: "hot-updater:///assets/probe.ttf",
      ...overrides,
    })}`,
  );
}

function recoveredSequence(
  options: {
    readonly boundary?: string | null;
    readonly error?: string;
    readonly font?: string;
    readonly ready?: string;
    readonly envelope?: LogEnvelope;
  } = {},
): string {
  const envelope = options.envelope ?? log;
  return [
    options.boundary === undefined
      ? matrixEvent("generationWillEvaluate", {}, envelope)
      : options.boundary,
    options.error ?? engineError({}, false, envelope),
    options.font ??
      matrixEvent(
        "fontLoaded",
        {
          path: "assets/probe.ttf",
          sha256: SHA,
        },
        envelope,
      ),
    options.ready ??
      matrixEvent(
        "jsReady",
        { confirmation: { status: "CONFIRMED" } },
        envelope,
      ),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function expectRejected(logs: string, code = 302): void {
  expect(findManagedResourceEngineErrorCodes(logs)).toEqual([code]);
  expect(() => assertNoManagedResourceEngineErrors(logs)).toThrow(
    `Managed Lynx resources emitted engine errors: ${code}`,
  );
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

function capturedJournal(mutate?: (journal: CapturedJournal) => void): string {
  const journal = JSON.parse(YNQB7P_JOURNAL) as CapturedJournal;
  mutate?.(journal);
  journal.events.forEach((event, index) => {
    event.sequence = String(index + 1);
  });
  journal.nextSequence = String(journal.events.length + 1);
  return canonical(journal);
}

function capturedEvidence(
  runtimeJournalUtf8 = YNQB7P_JOURNAL,
  overrides: Record<string, unknown> = {},
) {
  let journal: CapturedJournal;
  try {
    journal = JSON.parse(runtimeJournalUtf8) as CapturedJournal;
  } catch {
    journal = JSON.parse(YNQB7P_JOURNAL) as CapturedJournal;
  }
  const first = journal.events[0];
  const last = journal.events.at(-1);
  return {
    currentProcessId: "7690",
    expectedLaunchGeneration: "launch-ynqb7p",
    runtimeJournalUtf8,
    screenStateResponse: {
      launchGeneration: "launch-ynqb7p",
      screenState: {
        currentBundleId: "00000000-0000-7000-8000-000000000000",
        currentReleaseId: null,
        generationEvents: JSON.stringify({
          events: journal.events,
          latestSequence: last?.sequence ?? null,
          oldestSequence: first?.sequence ?? null,
          schemaVersion: 1,
          truncated: journal.truncated,
        }),
        launchStatus: "Current Launch Status: CONFIRMED",
        runtimeScenarioMarker: "targeted-qa-detox",
      },
    },
    ...overrides,
  };
}

describe("managed Lynx resource engine errors", () => {
  it("accepts the captured ynqb7p Android journal and exact PID-scoped diagnostic", () => {
    expect(
      crypto.createHash("sha256").update(YNQB7P_JOURNAL).digest("hex"),
    ).toBe("54dad8d20acf69241f7ebf775cdc66177bb63db922519b9a4f13d07836abfd7b");
    expect(YNQB7P_LOG).not.toContain("HOT_UPDATER_MATRIX_EVENT");
    expect(
      findManagedResourceEngineErrorCodes(YNQB7P_LOG, capturedEvidence()),
    ).toEqual([]);
  });

  it.each([
    [
      "stale screen journal",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          journal.events.at(-1)!.details.attemptId = "stale-attempt";
        });
        return {
          ...capturedEvidence(runtimeJournalUtf8),
          screenStateResponse: capturedEvidence().screenStateResponse,
        };
      },
    ],
    [
      "cross-generation font",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          journal.events.find(
            (event) => event.name === "fontLoaded",
          )!.details.generationId = "other-generation";
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
    ...[
      ["runtimeId", "other-runtime"],
      ["contextId", "other-context"],
      ["attemptId", "other-attempt"],
      ["bundleId", "other-bundle"],
      ["releaseId", "other-release"],
    ].map(([field, value]) => [
      `cross-${field} font`,
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          journal.events.find((event) => event.name === "fontLoaded")!.details[
            field
          ] = value;
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ]),
    [
      "wrong current PID",
      () => capturedEvidence(YNQB7P_JOURNAL, { currentProcessId: "7691" }),
    ],
    [
      "wrong font path",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          journal.events.find(
            (event) => event.name === "fontLoaded",
          )!.details.path = "assets/other.ttf";
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
    [
      "invalid font SHA",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          journal.events.find(
            (event) => event.name === "fontLoaded",
          )!.details.sha256 = "invalid";
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
    [
      "readiness before font",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          const fontIndex = journal.events.findIndex(
            (event) => event.name === "fontLoaded",
          );
          const [font] = journal.events.splice(fontIndex, 1);
          journal.events.push(font);
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
    [
      "new generation boundary",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          const details = structuredClone(journal.events.at(-1)!.details);
          details.generationId = "other-generation";
          journal.events.splice(-1, 0, {
            details,
            name: "generationWillEvaluate",
            sequence: "15",
          });
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
    [
      "retirement after readiness",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          journal.events.push({
            details: structuredClone(journal.events.at(-1)!.details),
            name: "generationWillRetire",
            sequence: "16",
          });
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
    [
      "fatal boundary",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          journal.events.splice(-1, 0, {
            details: structuredClone(journal.events.at(-1)!.details),
            name: "generationFailed",
            sequence: "15",
          });
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
    ["malformed journal", () => capturedEvidence("{")],
    ["missing journal", () => capturedEvidence("")],
    [
      "missing screen identity",
      () => {
        const evidence = capturedEvidence();
        evidence.screenStateResponse.screenState.generationEvents = null;
        return evidence;
      },
    ],
    [
      "missing font identity",
      () => {
        const runtimeJournalUtf8 = capturedJournal((journal) => {
          delete journal.events.find((event) => event.name === "fontLoaded")!
            .details.attemptId;
        });
        return capturedEvidence(runtimeJournalUtf8);
      },
    ],
  ])("rejects journal recovery with %s", (_case, evidence) => {
    expect(findManagedResourceEngineErrorCodes(YNQB7P_LOG, evidence())).toEqual(
      [302],
    );
  });

  it("accepts an ordered, verified threadtime font recovery", () => {
    expect(findManagedResourceEngineErrorCodes(recoveredSequence())).toEqual(
      [],
    );
    expect(() =>
      assertNoManagedResourceEngineErrors(recoveredSequence()),
    ).not.toThrow();
  });

  it("accepts an ordered, verified brief font recovery", () => {
    expect(
      findManagedResourceEngineErrorCodes(
        recoveredSequence({ envelope: briefLog }),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "malformed diagnostic JSON",
      recoveredSequence({
        error: log("engine-error fatal=false code=302 message={"),
      }),
    ],
    [
      "missing fatal field",
      recoveredSequence({ error: log("engine-error code=302 message={}") }),
    ],
    ["fatal diagnostic", recoveredSequence({ error: engineError({}, true) })],
    [
      "wrong error code",
      recoveredSequence({ error: engineError({ error_code: 301 }) }),
    ],
    [
      "wrong subtype",
      recoveredSequence({ error: engineError({ sub_code: 30202 }) }),
    ],
    [
      "wrong resource type",
      recoveredSequence({ error: engineError({ type: "image" }) }),
    ],
    [
      "wrong scheme",
      recoveredSequence({
        error: engineError({ src: "https://example.test/assets/probe.ttf" }),
      }),
    ],
    [
      "noncanonical path",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets/../probe.ttf" }),
      }),
    ],
    [
      "dot path segment",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets/./probe.ttf" }),
      }),
    ],
    [
      "empty path segment",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets//probe.ttf" }),
      }),
    ],
    [
      "trailing path delimiter",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets/" }),
      }),
    ],
    [
      "backslash path delimiter",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets\\probe.ttf" }),
      }),
    ],
    [
      "URL query delimiter",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets/probe.ttf?cache" }),
      }),
    ],
    [
      "URL fragment delimiter",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets/probe.ttf#font" }),
      }),
    ],
    [
      "path containing a colon",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets:probe.ttf" }),
      }),
    ],
    [
      "path containing an ASCII control",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets/\u001fprobe.ttf" }),
      }),
    ],
    [
      "percent-encoded path",
      recoveredSequence({
        error: engineError({ src: "hot-updater:///assets/%70robe.ttf" }),
      }),
    ],
    [
      "path exceeding the native UTF-8 limit",
      recoveredSequence({
        error: engineError({
          src: `hot-updater:///assets/${"é".repeat(509)}`,
        }),
      }),
    ],
    [
      "wrong recovered path",
      recoveredSequence({
        font: matrixEvent("fontLoaded", {
          path: "assets/other.ttf",
          sha256: SHA,
        }),
      }),
    ],
    [
      "invalid recovered SHA",
      recoveredSequence({
        font: matrixEvent("fontLoaded", {
          path: "assets/probe.ttf",
          sha256: "not-a-sha",
        }),
      }),
    ],
    [
      "malformed recovery JSON",
      [
        matrixEvent("generationWillEvaluate"),
        engineError(),
        log("HOT_UPDATER_MATRIX_EVENT {"),
        matrixEvent("fontLoaded", {
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
        matrixEvent("jsReady", { confirmation: { status: "CONFIRMED" } }),
      ].join("\n"),
    ],
    [
      "readiness before recovery",
      [
        matrixEvent("generationWillEvaluate"),
        matrixEvent("jsReady", { confirmation: { status: "CONFIRMED" } }),
        engineError(),
        matrixEvent("fontLoaded", {
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
      ].join("\n"),
    ],
    [
      "recovery before diagnostic",
      [
        matrixEvent("generationWillEvaluate"),
        matrixEvent("fontLoaded", {
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
        engineError(),
        matrixEvent("jsReady", { confirmation: { status: "CONFIRMED" } }),
      ].join("\n"),
    ],
    [
      "wrong recovery identity",
      recoveredSequence({
        font: matrixEvent("fontLoaded", {
          generationId: "generation-B",
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
      }),
    ],
    [
      "wrong readiness bundle",
      recoveredSequence({
        ready: matrixEvent("jsReady", {
          bundleId: "bundle-B",
          confirmation: { status: "CONFIRMED" },
        }),
      }),
    ],
    [
      "wrong readiness generation",
      recoveredSequence({
        ready: matrixEvent("jsReady", {
          generationId: "generation-B",
          confirmation: { status: "CONFIRMED" },
        }),
      }),
    ],
    [
      "wrong readiness attempt",
      recoveredSequence({
        ready: matrixEvent("jsReady", {
          attemptId: "attempt-B",
          confirmation: { status: "CONFIRMED" },
        }),
      }),
    ],
    [
      "wrong engine process",
      recoveredSequence({
        error: engineError().replace("  1234  1234 ", "  9999  9999 "),
      }),
    ],
    [
      "missing preceding runtime identity",
      recoveredSequence({ boundary: null }),
    ],
    [
      "missing recovery",
      [
        matrixEvent("generationWillEvaluate"),
        engineError(),
        matrixEvent("jsReady", { confirmation: { status: "CONFIRMED" } }),
      ].join("\n"),
    ],
    [
      "missing readiness",
      [
        matrixEvent("generationWillEvaluate"),
        engineError(),
        matrixEvent("fontLoaded", {
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
      ].join("\n"),
    ],
    [
      "non-confirmed readiness",
      recoveredSequence({
        ready: matrixEvent("jsReady", {
          confirmation: { status: "ALREADY_CONFIRMED" },
        }),
      }),
    ],
  ])("rejects %s", (_case, logs) => {
    expectRejected(logs);
  });

  it("rejects generation B recovery and readiness for a generation A diagnostic", () => {
    const generationB = {
      runtimeId: "runtime-B",
      generationId: "generation-B",
      contextId: "context-B",
      attemptId: "attempt-B",
      bundleId: "bundle-B",
      releaseId: "release-B",
    };
    expectRejected(
      [
        matrixEvent("generationWillEvaluate"),
        engineError(),
        matrixEvent("generationWillEvaluate", generationB),
        matrixEvent("fontLoaded", {
          ...generationB,
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
        matrixEvent("jsReady", {
          ...generationB,
          confirmation: { status: "CONFIRMED" },
        }),
      ].join("\n"),
    );
  });

  it.each([
    [
      "retirement before font recovery",
      [
        matrixEvent("generationWillEvaluate"),
        engineError(),
        matrixEvent("generationWillRetire"),
        matrixEvent("fontLoaded", {
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
        matrixEvent("jsReady", { confirmation: { status: "CONFIRMED" } }),
      ].join("\n"),
    ],
    [
      "retirement before confirmed readiness",
      [
        matrixEvent("generationWillEvaluate"),
        engineError(),
        matrixEvent("fontLoaded", {
          path: "assets/probe.ttf",
          sha256: SHA,
        }),
        matrixEvent("generationRetired"),
        matrixEvent("jsReady", { confirmation: { status: "CONFIRMED" } }),
      ].join("\n"),
    ],
  ])("rejects same-identity %s", (_case, logs) => {
    expectRejected(logs);
  });

  it.each([
    [
      "embedded diagnostic payload",
      recoveredSequence({
        error: log(
          `prefix engine-error fatal=false code=302 message=${JSON.stringify({
            error_code: 302,
            sub_code: 30201,
            type: "font",
            src: "hot-updater:///assets/probe.ttf",
          })}`,
        ),
      }),
    ],
    [
      "diagnostic payload with trailing text",
      recoveredSequence({ error: `${engineError()} trailing` }),
    ],
    [
      "diagnostic nested inside the outer diagnostic JSON",
      recoveredSequence({
        error: engineError({
          error: "engine-error fatal=false code=301 message=nested",
        }),
      }),
    ],
    [
      "diagnostic under another tag",
      recoveredSequence({
        error: engineError().replace("HotUpdaterLynx", "OtherTag"),
      }),
    ],
    [
      "runtime marker under another tag",
      recoveredSequence({
        boundary: matrixEvent("generationWillEvaluate").replace(
          "HotUpdaterLynx",
          "OtherTag",
        ),
      }),
    ],
    [
      "unsupported outer log envelope",
      recoveredSequence({
        error: "HotUpdaterLynx: engine-error fatal=false code=302 message={}",
      }),
    ],
  ])("rejects %s", (_case, logs) => {
    expectRejected(logs);
  });

  it.each([301, 302])(
    "rejects unrecovered engine code %s even after native confirmation",
    (code) => {
      const logs = [
        "HotUpdaterLynx: confirmed bundle=bundle-A release=null attempt=attempt-A",
        `HotUpdaterLynx: engine-error fatal=false code=${code} message=resource failed`,
      ].join("\n");

      expectRejected(logs, code);
    },
  );

  it("rejects code 301 even when followed by the valid font sequence", () => {
    expectRejected(
      recoveredSequence({
        error: engineError().replace("code=302", "code=301"),
      }),
      301,
    );
  });

  it("rejects a malformed code 301 record", () => {
    expectRejected("HotUpdaterLynx: engine-error code=301", 301);
  });

  it("accepts native confirmation without managed-resource engine errors", () => {
    expect(() =>
      assertNoManagedResourceEngineErrors(
        "HotUpdaterLynx: confirmed bundle=bundle-A release=null attempt=attempt-A",
      ),
    ).not.toThrow();
  });
});
