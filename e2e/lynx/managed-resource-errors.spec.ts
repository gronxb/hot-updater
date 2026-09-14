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

function log(message: string, processId = "1234"): string {
  return `09-14 12:34:56.789  ${processId}  1234 I HotUpdaterLynx: ${message}`;
}

function matrixEvent(
  event: string,
  details: Record<string, unknown> = {},
): string {
  return log(
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
): string {
  return log(
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
    readonly error?: string;
    readonly font?: string;
    readonly ready?: string;
  } = {},
): string {
  return [
    options.error ?? engineError(),
    options.font ??
      matrixEvent("fontLoaded", {
        path: "assets/probe.ttf",
        sha256: SHA,
      }),
    options.ready ??
      matrixEvent("jsReady", { confirmation: { status: "CONFIRMED" } }),
  ].join("\n");
}

function expectRejected(logs: string, code = 302): void {
  expect(findManagedResourceEngineErrorCodes(logs)).toEqual([code]);
  expect(() => assertNoManagedResourceEngineErrors(logs)).toThrow(
    `Managed Lynx resources emitted engine errors: ${code}`,
  );
}

describe("managed Lynx resource engine errors", () => {
  it("accepts only an ordered, verified font recovery with matching readiness", () => {
    expect(findManagedResourceEngineErrorCodes(recoveredSequence())).toEqual(
      [],
    );
    expect(() =>
      assertNoManagedResourceEngineErrors(recoveredSequence()),
    ).not.toThrow();
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
    ["missing recovery", engineError()],
    [
      "missing readiness",
      [
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
