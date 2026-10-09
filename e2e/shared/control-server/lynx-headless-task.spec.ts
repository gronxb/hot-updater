import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertLynxHeadlessProcessStopped,
  assertLynxHeadlessTask,
  readLynxHeadlessManifest,
} from "./lynx-headless-task.ts";

const appId = "com.hotupdater.lynxexample";
const bundleId = "00000000-0000-7000-8000-000000000002";
const next = {
  kind: "BUNDLE",
  bundleId,
  releaseId: "release-staged",
  catalogId: "catalog",
  scopeKey: "production",
  generation: 3,
  catalogHash: "sha256:catalog",
  channel: "production",
  selectionContextHash: "v1:context",
};

function evidence() {
  const before = Buffer.from(
    JSON.stringify({
      next,
      confirmed: { ...next, bundleId: "stable", releaseId: "release-stable" },
      crashed: [],
      unconfirmed: [],
      interruptedReleases: {},
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      bundleId,
      assets: { "background-task.js": { fileHash: "task-hash" } },
    }),
  );
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  return {
    bundleId,
    before,
    after: Buffer.from(before),
    eventsBefore: Buffer.from("[]"),
    eventsAfter: Buffer.from("[]"),
    manifest,
    manifestHash,
    result: {
      success: true,
      processId: 1234,
      activitiesCreated: 0,
      activitiesStarted: 0,
      activitiesResumed: 0,
      taskId: "00000000-0000-4000-8000-000000000001",
      selection: { ...next },
      bundleId,
      releaseId: next.releaseId,
      manifestHash,
      entry: "background-task.js",
      value: JSON.stringify({ bundleId, marker: "headless-staged-detox" }),
    },
  };
}

describe("Lynx cold background evidence", () => {
  it("accepts a staged native receipt and script result with unchanged foreground state", () => {
    expect(() => assertLynxHeadlessTask(evidence())).not.toThrow();
  });

  it.each(["confirmed", "crashed", "interruptedReleases"])(
    "rejects a task that changes %s even with a valid script result",
    (key) => {
      const input = evidence();
      input.after = Buffer.from(
        JSON.stringify({
          ...JSON.parse(input.before.toString()),
          [key]: "changed",
        }),
      );
      expect(() => assertLynxHeadlessTask(input)).toThrow();
    },
  );

  it("rejects any foreground runtime event during the task", () => {
    const input = evidence();
    input.eventsAfter = Buffer.from('[{"type":"generation-created"}]');
    expect(() => assertLynxHeadlessTask(input)).toThrow();
  });

  it.each([
    "activitiesCreated",
    "activitiesStarted",
    "activitiesResumed",
  ] as const)(
    "rejects a process with %s even when it is backgrounded at completion",
    (field) => {
      const input = evidence();
      input.result[field] = 1;
      expect(() => assertLynxHeadlessTask(input)).toThrow();
    },
  );

  it("rejects a receipt from a different Release of the same Bundle", () => {
    const input = evidence();
    input.result.selection.releaseId = "other-release";
    input.result.releaseId = "other-release";
    expect(() => assertLynxHeadlessTask(input)).toThrow();
  });

  it("rejects a correct marker with the wrong native artifact digest", () => {
    const input = evidence();
    input.result.manifestHash = "other-manifest";
    expect(() => assertLynxHeadlessTask(input)).toThrow();
  });

  it.each([
    { bundleId: "stable", marker: "headless-staged-detox" },
    { bundleId, marker: "headless-stable-detox" },
  ])("rejects script output from other deployed bytes: %j", (output) => {
    const input = evidence();
    input.result.value = JSON.stringify(output);
    expect(() => assertLynxHeadlessTask(input)).toThrow();
  });

  it("does not accept an already confirmed staged Bundle", () => {
    const input = evidence();
    input.before = Buffer.from(JSON.stringify({ next, confirmed: next }));
    input.after = Buffer.from(input.before);
    expect(() => assertLynxHeadlessTask(input)).toThrow();
  });

  it("rejects an existing foreground attempt without relying on a journal mutation", () => {
    const input = evidence();
    input.before = Buffer.from(
      JSON.stringify({
        ...JSON.parse(input.before.toString()),
        pending: { selection: next },
      }),
    );
    input.after = Buffer.from(input.before);
    expect(() => assertLynxHeadlessTask(input)).toThrow();
  });

  it("reads the manifest only from the selected native scope", () => {
    const prefix = `/data/data/${appId}/files/hot-updater-lynx/scopes`;
    const relative = `artifacts/installations/${bundleId}/payload/manifest.json`;
    const files = new Map([
      [`${prefix}/first/${relative}`, Buffer.from("first")],
      [`${prefix}/second/${relative}`, Buffer.from("second")],
    ]);
    const read = (file: string) => files.get(file) ?? null;
    expect(
      readLynxHeadlessManifest({
        appId,
        scope: "second",
        bundleId,
        read,
      }).toString(),
    ).toBe("second");
    files.delete(`${prefix}/second/${relative}`);
    expect(() =>
      readLynxHeadlessManifest({ appId, scope: "second", bundleId, read }),
    ).toThrow();
  });

  it("accepts a checked process list without the app", () => {
    expect(() =>
      assertLynxHeadlessProcessStopped("NAME\ninit\nadbd\n", appId),
    ).not.toThrow();
  });

  it.each([
    "",
    "error: device offline",
    "PID NAME\n1234 other",
    `NAME\n${appId}\n`,
    `NAME\n${appId}:worker\n`,
  ])(
    "rejects absent or invalid process evidence and live app processes: %j",
    (output) => {
      expect(() => assertLynxHeadlessProcessStopped(output, appId)).toThrow();
    },
  );
});
