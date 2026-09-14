import { describe, expect, it } from "vitest";

import {
  collectDeltaDelivery,
  collectFatalPendingDetailLaunch,
  collectInvalidatedContexts,
  collectPendingDetailLaunch,
  collectProcessInterruption,
  collectReadyLaunch,
  collectSecondaryFatalFailure,
  hasCompleteAlreadyRunningDetailEvents,
  hasCompleteReadyEvents,
  hasCompletePendingDetailEvents,
  normalizeBuild,
  pageEntries,
  pageEssentialResources,
  resourcePaths,
  validateAttributedDiagnostics,
} from "../../examples/lynx/scripts/public-matrix/evidence.mjs";
import { SPARKLING_NAVIGATION_PROVENANCE } from "../../packages/lynx/src/navigationProvenance";

const identity = {
  runtimeId: "runtime",
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
  return {
    event,
    ...identity,
    pageAttemptId: null,
    transitionId: null,
    ...details,
  };
}

function evidenceEvents() {
  const mainPaths = resourcePaths.filter(
    (path) => path !== "detail.lynx.bundle",
  );
  return [
    event("generationWillEvaluate", { primary: true }),
    event("generationStarted", {
      contextIds: [identity.contextId],
      primaryContextId: identity.contextId,
      orderedPageEntries: ["main.lynx.bundle"],
      topPageEntry: "main.lynx.bundle",
      reason: "initial",
    }),
    ...mainPaths.flatMap((path) => [
      event("resourceLeaseAcquired", {
        path,
        sha256: files[path].sha256,
      }),
      event(
        path === "assets/probe.png"
          ? "imageLoaded"
          : path === "assets/probe.ttf"
            ? "fontLoaded"
            : "resourceLoaded",
        { path, sha256: files[path].sha256 },
      ),
    ]),
    event("firstContent"),
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
    event("routeOpened", {
      contextId: secondaryContextId,
      pageAttemptId: "page-attempt-b",
      sourceContextId: identity.contextId,
      pageEntry: "detail.lynx.bundle",
      pageParameters: { title: "Second Page" },
      orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
      topPageEntry: "detail.lynx.bundle",
      nativePageClass:
        "com.hotupdater.lynx.sparkling.HotUpdaterSparklingPageActivity",
      outcome: "opened",
    }),
    event("resourceLeaseAcquired", {
      contextId: secondaryContextId,
      path: "detail.lynx.bundle",
      sha256: files["detail.lynx.bundle"].sha256,
    }),
    event("resourceLoaded", {
      contextId: secondaryContextId,
      path: "detail.lynx.bundle",
      sha256: files["detail.lynx.bundle"].sha256,
    }),
    event("firstContent", { contextId: secondaryContextId }),
    event("pageAdmitted", {
      contextId: secondaryContextId,
      pageAttemptId: "page-attempt-b",
      confirmation: { status: "PAGE_ADMITTED" },
    }),
    event("pageAttemptTerminal", {
      contextId: secondaryContextId,
      pageAttemptId: "page-attempt-b",
      terminal: "admitted",
    }),
    event("generationWillRetire", {
      contextIds: [identity.contextId, secondaryContextId],
      reason: "reload",
    }),
    ...mainPaths.map((path) =>
      event("resourceLeaseReleased", {
        path,
        sha256: files[path].sha256,
      }),
    ),
    event("resourceLeaseReleased", {
      contextId: secondaryContextId,
      path: "detail.lynx.bundle",
      sha256: files["detail.lynx.bundle"].sha256,
    }),
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
  it("accepts a detail admission slice captured after generation start", () => {
    const postStart = evidenceEvents().filter(
      (item) =>
        !["generationWillEvaluate", "generationStarted", "jsReady"].includes(
          item.event,
        ) && item.contextId === secondaryContextId,
    );
    const opened = evidenceEvents().find((item) =>
      ["pageOpened", "routeOpened"].includes(item.event),
    );
    expect(opened).toBeDefined();
    postStart.unshift(opened!);

    expect(hasCompleteReadyEvents(postStart, build, identity.processId)).toBe(
      false,
    );
    expect(
      hasCompleteAlreadyRunningDetailEvents(
        postStart,
        build,
        identity.processId,
      ),
    ).toBe(true);
  });

  it("preserves the compiler-authored page graph and navigation provenance", () => {
    const compilerReceipt = {
      files: resourcePaths.map((path, index) => ({
        path,
        sha256: String(index + 1).repeat(64),
        bytes: index + 1,
      })),
      pageEntries,
      pageEssentialResources,
      provenance: {
        framework: "ReactLynx",
        rspeedy: "0.116.5",
        sparklingNavigation: SPARKLING_NAVIGATION_PROVENANCE,
      },
    };
    expect(
      normalizeBuild({
        role: "B",
        compilerReceipt,
        deploymentReceipt: {
          bundleId: "bundle-b",
          releaseId: "release-b",
          persistedManifestFileHash: "a".repeat(64),
        },
        runtimeId: "runtime",
      }),
    ).toMatchObject({
      pageEntries,
      pageEssentialResources,
      sparklingNavigation: SPARKLING_NAVIGATION_PROVENANCE,
    });
    expect(() =>
      normalizeBuild({
        role: "B",
        compilerReceipt: {
          ...compilerReceipt,
          pageEntries: ["main.lynx.bundle"],
        },
        deploymentReceipt: { bundleId: "bundle-b", releaseId: "release-b" },
        runtimeId: "runtime",
      }),
    ).toThrow("invalid page entry set");
  });

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
      deliveryArtifactUrl:
        "https://example.test/artifacts/bundle-c/from/bundle-b",
      deliveryArtifactResponse: {
        fileHash: null,
        fileUrl: null,
        manifestUrl: "https://example.test/manifest",
        manifestFileHash: "d".repeat(64),
        changedAssets: {
          "detail.lynx.bundle": {
            file: { url: "https://example.test/detail" },
            fileHash: build.files["detail.lynx.bundle"].sha256,
          },
          "main.lynx.bundle": {
            file: { url: "https://example.test/main" },
            fileHash: targetHash,
            patch: {
              algorithm: "bsdiff",
              baseBundleId: "bundle-b",
              baseFileHash: "c".repeat(64),
              patchFileHash: patchHash,
              patchUrl: "https://example.test/main.patch",
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
        transactionId: "transaction-rejected-detail",
        bundleId: "bundle-c",
        releaseId: "release-c",
        baseBundleId: "bundle-b",
        asset: "main.lynx.bundle",
        patchFileHash: patchHash,
        reconstructedFileHash: targetHash,
      },
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
      rawDetailAssetPath: "detail.lynx.bundle",
      rawDetailSha256: build.files["detail.lynx.bundle"].sha256,
      transactionId: "transaction-c",
      patchSha256: patchHash,
      reconstructedSha256: targetHash,
    });
    expect(() =>
      collectDeltaDelivery(
        deployment,
        nativeLogs.replaceAll(targetHash, "d".repeat(64)),
      ),
    ).toThrow();
    expect(() =>
      collectDeltaDelivery(
        {
          ...deployment,
          deliveryArtifactResponse: {
            ...deployment.deliveryArtifactResponse,
            changedAssets: {
              ...deployment.deliveryArtifactResponse.changedAssets,
              "detail.lynx.bundle": undefined,
            },
          },
        },
        nativeLogs,
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
    expect(ready.resources).toHaveLength(resourcePaths.length - 1);
    expect(
      ready.resources.every((resource: any) => resource.leaseReleased),
    ).toBe(true);
    expect(collectInvalidatedContexts(events, ready)).toMatchObject({
      contextIds: [identity.contextId, secondaryContextId],
      leaseScope: "context",
      expectedLeaseCount: resourcePaths.length,
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

  it("proves a real pending detail without fabricating admission", () => {
    const events = evidenceEvents().filter(
      (candidate) =>
        candidate.event !== "pageAdmitted" &&
        candidate.event !== "pageAttemptTerminal",
    );
    expect(
      hasCompletePendingDetailEvents(events, build, identity.processId, true),
    ).toBe(true);
    expect(
      collectPendingDetailLaunch({
        phaseEvents: events,
        allEvents: events,
        build,
        processId: identity.processId,
        primaryReady: true,
      }),
    ).toMatchObject({
      detailReadinessWithheld: true,
      members: [
        { primary: true },
        { primary: false, pageAdmitted: null, pageAttemptTerminal: null },
      ],
    });
  });

  it("records process death as interruption without fatal classification", () => {
    const events = evidenceEvents().filter(
      (candidate) =>
        candidate.event !== "pageAdmitted" &&
        candidate.event !== "pageAttemptTerminal" &&
        !candidate.event.startsWith("generationRetir") &&
        candidate.event !== "resourceLeaseReleased" &&
        candidate.event !== "staleContextRejected",
    );
    const launch = collectPendingDetailLaunch({
      phaseEvents: events,
      allEvents: events,
      build,
      processId: identity.processId,
      primaryReady: true,
    });
    const interrupted = event("pageAttemptTerminal", {
      contextId: secondaryContextId,
      pageAttemptId: "page-attempt-b",
      terminal: "process-interruption",
    });
    expect(
      collectProcessInterruption([...events, interrupted], launch),
    ).toMatchObject({
      contextId: secondaryContextId,
      pageAttemptId: "page-attempt-b",
      terminal: "process-interruption",
    });
    expect(() =>
      collectProcessInterruption([...events, interrupted, interrupted], launch),
    ).toThrow("exactly one durable terminal");
  });

  it("proves fatal classification after real detail content but before admission", () => {
    const source = evidenceEvents().filter(
      (candidate) =>
        candidate.event !== "pageAdmitted" &&
        candidate.event !== "pageAttemptTerminal",
    );
    const retirementAt = source.findIndex(
      (candidate) => candidate.event === "generationWillRetire",
    );
    const events = [
      ...source.slice(0, retirementAt),
      event("runtimeFailed", {
        contextId: secondaryContextId,
        pageAttemptId: "page-attempt-b",
      }),
      event("pageAttemptTerminal", {
        contextId: secondaryContextId,
        pageAttemptId: "page-attempt-b",
        terminal: "verified-fatal",
      }),
      event("generationFailed", { contextId: secondaryContextId }),
      ...source
        .slice(retirementAt)
        .map((candidate) =>
          candidate.event === "generationWillRetire" ||
          candidate.event === "generationRetired"
            ? { ...candidate, reason: "recovery" }
            : candidate,
        ),
    ];
    const launch = collectFatalPendingDetailLaunch({
      phaseEvents: events,
      allEvents: events,
      build,
      processId: identity.processId,
      primaryReady: true,
    });
    expect(launch).toMatchObject({
      detailReadinessWithheld: true,
      detailFailedBeforeAdmission: true,
      members: [
        { primary: true },
        {
          primary: false,
          firstContent: { contextId: secondaryContextId },
          pageAdmitted: null,
        },
      ],
    });
    expect(collectSecondaryFatalFailure(events, launch)).toMatchObject({
      pageAttemptTerminal: { terminal: "verified-fatal" },
    });
  });

  it("rejects obsolete page-attempt terminal vocabulary", () => {
    expect(() =>
      validateAttributedDiagnostics([
        event("pageAttemptTerminal", { terminal: "fatal" }),
      ]),
    ).toThrow("Invalid page-attempt terminal state");
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
      .filter(
        (candidate) =>
          candidate.event !== "jsReady" &&
          candidate.event !== "pageAdmitted" &&
          candidate.event !== "pageAttemptTerminal",
      );
    const events = [
      ...startup,
      event("runtimeFailed", {
        contextId: secondaryContextId,
        pageAttemptId: "page-attempt-b",
      }),
      event("pageAttemptTerminal", {
        contextId: secondaryContextId,
        pageAttemptId: "page-attempt-b",
        terminal: "verified-fatal",
      }),
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
    const ready = collectFatalPendingDetailLaunch({
      phaseEvents: events,
      allEvents: events,
      build,
      processId: identity.processId,
      primaryReady: false,
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
