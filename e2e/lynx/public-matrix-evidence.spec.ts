import { describe, expect, it } from "vitest";

import {
  collectDeltaDelivery,
  collectInvalidatedContexts,
  collectReadyLaunch,
  collectSecondaryFatalFailure,
  collectUnconfirmedLaunch,
  hasCompleteReadyEvents,
  hasCompleteUnconfirmedEvents,
  resourcePaths,
  validateAttributedDiagnostics,
} from "../../examples/lynx/scripts/public-matrix/evidence.mjs";

const identity = {
  processId: "101",
  generationId: "generation-b",
  contextId: "context-b",
  attemptId: "attempt-b",
  bundleId: "bundle-b",
  releaseId: "release-b",
};
const secondaryContextId = "context-b-secondary";
const files = Object.fromEntries(
  resourcePaths.map((path, index) => [
    path,
    { sha256: String(index + 1).repeat(64), byteSize: index + 1 },
  ]),
);
const build = {
  variant: "B",
  bundleId: identity.bundleId,
  releaseId: identity.releaseId,
  files,
};

function event(event: string, details: Record<string, unknown> = {}) {
  return { event, ...identity, ...details };
}

function evidenceEvents() {
  return [
    event("generationWillEvaluate", { primary: true }),
    event("generationWillEvaluate", {
      contextId: secondaryContextId,
      primary: false,
    }),
    event("generationStarted", {
      contextIds: [identity.contextId, secondaryContextId],
      primaryContextId: identity.contextId,
      reason: "initial",
    }),
    ...resourcePaths.flatMap((path) =>
      [identity.contextId, secondaryContextId].flatMap((contextId) => [
        event("resourceLeaseAcquired", {
          contextId,
          path,
          sha256: files[path].sha256,
        }),
        event(
          path === "assets/probe.png"
            ? "imageLoaded"
            : path === "assets/probe.ttf"
              ? "fontLoaded"
              : "resourceLoaded",
          { contextId, path, sha256: files[path].sha256 },
        ),
      ]),
    ),
    event("firstContent"),
    event("firstContent", { contextId: secondaryContextId }),
    event("jsReady", {
      confirmation: {
        status: "CONFIRMED",
        transition: {
          kind: "UPDATE_APPLIED",
          from: {
            kind: "BUILTIN",
            bundleId: "bundle-a",
            releaseId: null,
            channel: "matrix",
          },
          to: {
            kind: "BUNDLE",
            bundleId: identity.bundleId,
            releaseId: identity.releaseId,
            channel: "matrix",
          },
        },
      },
    }),
    event("generationWillRetire", {
      contextIds: [identity.contextId, secondaryContextId],
      reason: "reload",
    }),
    ...resourcePaths.flatMap((path) =>
      [identity.contextId, secondaryContextId].map((contextId) =>
        event("resourceLeaseReleased", {
          contextId,
          path,
          sha256: files[path].sha256,
        }),
      ),
    ),
    event("generationRetired", {
      contextIds: [identity.contextId, secondaryContextId],
      inFlightResourceCount: 0,
      reason: "reload",
    }),
    event("staleContextRejected", { code: "STALE_CONTEXT" }),
    event("staleContextRejected", {
      contextId: secondaryContextId,
      code: "STALE_CONTEXT",
    }),
  ];
}

describe("Lynx public matrix native event evidence", () => {
  it("fails closed when an iOS event file contains no host callbacks", () => {
    expect(() =>
      collectReadyLaunch({
        phaseEvents: [],
        allEvents: [],
        build,
        processId: identity.processId,
      }),
    ).toThrow("Missing generationStarted");
  });

  it("fails closed when the native event sink is empty", () => {
    expect(() =>
      collectReadyLaunch({
        phaseEvents: [],
        allEvents: [],
        build,
        processId: identity.processId,
      }),
    ).toThrow("Missing generationStarted");
  });

  it("uses one structured install transaction and observed reconstructed hash", () => {
    const patchHash = "a".repeat(64);
    const targetHash = "b".repeat(64);
    const deployment = {
      bundleId: "bundle-c",
      releaseId: "release-c",
      deliveryArtifactResponse: {
        changedAssets: {
          "main.lynx.bundle": {
            fileHash: targetHash,
            patch: {
              algorithm: "bsdiff",
              baseBundleId: "bundle-b",
              baseFileHash: "c".repeat(64),
              patchFileHash: patchHash,
            },
          },
        },
      },
    };
    const marker = "HotUpdaterLynxEvent=";
    const nativeLogs = [
      {
        schemaVersion: 1,
        event: "HotUpdaterBsdiffPatchApplied",
        transactionId: "transaction-c",
        bundleId: "bundle-c",
        releaseId: "release-c",
        baseBundleId: "bundle-b",
        asset: "main.lynx.bundle",
        patchFileHash: patchHash,
        reconstructedFileHash: targetHash,
      },
      {
        schemaVersion: 1,
        event: "HotUpdaterManifestDiffApplied",
        transactionId: "transaction-c",
        bundleId: "bundle-c",
        releaseId: "release-c",
        baseBundleId: "bundle-b",
      },
    ]
      .map((value) => `${marker}${JSON.stringify(value)}`)
      .join("\n");
    expect(collectDeltaDelivery(deployment, nativeLogs)).toMatchObject({
      transactionId: "transaction-c",
      patchSha256: patchHash,
      reconstructedSha256: targetHash,
    });
    expect(() =>
      collectDeltaDelivery(
        deployment,
        nativeLogs.replace(targetHash, "d".repeat(64)),
      ),
    ).toThrow();
  });

  it("correlates ready resources and ordered retirement to one identity", () => {
    const events = evidenceEvents();
    const ready = collectReadyLaunch({
      phaseEvents: events,
      allEvents: events,
      build,
      processId: identity.processId,
    });
    expect(ready.identity).toEqual(identity);
    expect(ready.confirmation).toMatchObject({
      status: "CONFIRMED",
      transition: { kind: "UPDATE_APPLIED" },
    });
    expect(ready.resources).toHaveLength(resourcePaths.length);
    expect(
      ready.resources.every((resource: any) => resource.leaseReleased),
    ).toBe(true);
    expect(collectInvalidatedContexts(events, ready)).toMatchObject({
      contextIds: [identity.contextId, secondaryContextId],
      leaseScope: "context",
      expectedLeaseCount: resourcePaths.length * 2,
      inFlightResourceCount: 0,
      allLeasesBalanced: true,
      oldContextsInvalidated: true,
      lateOldContextEventCount: 0,
    });
  });

  it("does not report readiness before delayed jsReady and resources arrive", () => {
    const events = evidenceEvents();
    const retiredAt = events.findIndex(
      (candidate) => candidate.event === "generationWillRetire",
    );
    const launchEvents = events.slice(0, retiredAt);
    const jsReadyAt = launchEvents.findIndex(
      (candidate) => candidate.event === "jsReady",
    );
    expect(
      hasCompleteReadyEvents(
        launchEvents.slice(0, jsReadyAt),
        build,
        identity.processId,
      ),
    ).toBe(false);
    const fontAt = launchEvents.findIndex(
      (candidate) =>
        candidate.event === "fontLoaded" &&
        candidate.path === "assets/probe.ttf",
    );
    expect(
      hasCompleteReadyEvents(
        launchEvents.filter((_, index) => index !== fontAt),
        build,
        identity.processId,
      ),
    ).toBe(false);
    expect(
      hasCompleteReadyEvents(launchEvents, build, identity.processId),
    ).toBe(true);
  });

  it("rejects an old-generation lease released after generationRetired", () => {
    const events = evidenceEvents();
    const release = events.find(
      (candidate) => candidate.event === "resourceLeaseReleased",
    )!;
    events.splice(events.indexOf(release), 1);
    events.push(release);
    const ready = collectReadyLaunch({
      phaseEvents: events,
      allEvents: events,
      build,
      processId: identity.processId,
    });
    expect(() => collectInvalidatedContexts(events, ready)).toThrow(
      "Every old-generation lease must have one matching release",
    );
  });

  it("rejects any old-context callback after generation retirement", () => {
    const events = evidenceEvents();
    events.push(
      event("resourceLoaded", {
        path: resourcePaths[0],
        sha256: files[resourcePaths[0]].sha256,
      }),
    );
    const ready = collectReadyLaunch({
      phaseEvents: events,
      allEvents: events,
      build,
      processId: identity.processId,
    });
    expect(() => collectInvalidatedContexts(events, ready)).toThrow(
      "old-context event was emitted after generationRetired",
    );
  });

  it("requires terminal reconstruction failures to retain full generation identity", () => {
    const complete = event("generationReconstructionFailed", {
      contextIds: [identity.contextId, secondaryContextId],
      reason: "recovery",
      message: "secondary reconstruction failed",
    });
    expect(() => validateAttributedDiagnostics([complete])).not.toThrow();
    expect(() =>
      validateAttributedDiagnostics([{ ...complete, generationId: undefined }]),
    ).toThrow("missing generationId");
    expect(() =>
      validateAttributedDiagnostics([{ ...complete, contextIds: [] }]),
    ).toThrow("exact managed contextIds");
  });

  it("attributes fatal recovery to the secondary and retires the full generation", () => {
    const source = evidenceEvents();
    const retirementAt = source.findIndex(
      (candidate) => candidate.event === "generationWillRetire",
    );
    const releases = source.filter(
      (candidate) => candidate.event === "resourceLeaseReleased",
    );
    const startup = source
      .slice(0, retirementAt)
      .filter((candidate) => candidate.event !== "jsReady");
    expect(
      hasCompleteUnconfirmedEvents(startup, build, identity.processId),
    ).toBe(true);
    const events = [
      ...startup,
      event("runtimeFailed", { contextId: secondaryContextId }),
      event("generationFailed", { contextId: secondaryContextId }),
      event("generationWillRetire", {
        contextIds: [identity.contextId, secondaryContextId],
        reason: "recovery",
      }),
      ...releases,
      event("generationRetired", {
        contextIds: [identity.contextId, secondaryContextId],
        inFlightResourceCount: 0,
        reason: "recovery",
      }),
    ];
    const ready = collectUnconfirmedLaunch({
      phaseEvents: events,
      allEvents: events,
      build,
      processId: identity.processId,
    });
    expect(collectSecondaryFatalFailure(events, ready)).toMatchObject({
      event: "runtimeFailed",
      contextId: secondaryContextId,
    });
    expect(
      collectInvalidatedContexts(events, ready, {
        reason: "recovery",
        requireStaleAuthorities: false,
      }),
    ).toMatchObject({
      contextIds: [identity.contextId, secondaryContextId],
      allLeasesBalanced: true,
    });
  });
});
