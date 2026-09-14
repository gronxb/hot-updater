import { describe, expect, it } from "vitest";

import {
  assertNoManagedResourceEngineErrors,
  findManagedResourceEngineErrorCodes,
} from "./managed-resource-errors";

const SHA = "a".repeat(64);
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

describe("managed Lynx resource engine errors", () => {
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
