import { describe, expect, it } from "vitest";

import {
  expectedLynxMatrixCellIds,
  LYNX_MATRIX_RESOURCE_PATHS,
  validateLynxMatrixCell,
  validateLynxMatrixSummary,
} from "./public-matrix-contract";

const hash = (value: string) => value.repeat(64).slice(0, 64);

function makeBuild(variant: string, marker: string) {
  return {
    variant,
    compiler: "ReactLynx",
    compilerVersion: "0.116.5",
    runtimeId: "lynx-runtime",
    bundleId: `${variant.toLowerCase()}-bundle`,
    releaseId: variant === "A" ? null : `${variant.toLowerCase()}-release`,
    manifestSha256: hash(marker),
    files: Object.fromEntries(
      LYNX_MATRIX_RESOURCE_PATHS.map((path, index) => [
        path,
        { sha256: hash(String(index + 1)), byteSize: index + 1 },
      ]),
    ),
  };
}

function selectionSummary(build: ReturnType<typeof makeBuild>) {
  return {
    kind: build.releaseId === null ? "BUILTIN" : "BUNDLE",
    bundleId: build.bundleId,
    releaseId: build.releaseId,
    channel: "matrix",
  };
}

function transitionConfirmation(
  kind: "UPDATE_APPLIED" | "RECOVERED",
  from: ReturnType<typeof makeBuild>,
  to: ReturnType<typeof makeBuild>,
) {
  return {
    status: kind === "UPDATE_APPLIED" ? "CONFIRMED" : "ALREADY_CONFIRMED",
    transition: {
      kind,
      from: selectionSummary(from),
      to: selectionSummary(to),
    },
  };
}

function makeReady(
  build: ReturnType<typeof makeBuild>,
  processId: string,
  generationId: string,
  contextId: string,
  confirmation: any = {
    status: "ALREADY_CONFIRMED",
    transition: null,
  },
) {
  const identity = {
    processId,
    generationId,
    contextId,
    attemptId: `${contextId}-attempt`,
    bundleId: build.bundleId,
    releaseId: build.releaseId,
  };
  const contextIds = [contextId, `${contextId}-secondary`];
  const makeMember = (memberContextId: string, primary: boolean) => {
    const memberIdentity = { ...identity, contextId: memberContextId };
    return {
      identity: memberIdentity,
      primary,
      readinessAuthority: primary,
      evaluationSequence: primary ? 1 : 2,
      firstContentSequence: 4,
      jsReadySequence: primary ? 12 : null,
      firstContent: { ...memberIdentity },
      jsReady: primary ? { ...memberIdentity } : null,
      confirmation: primary ? confirmation : null,
      resources: LYNX_MATRIX_RESOURCE_PATHS.map((path, index) => ({
        path,
        sha256: build.files[path].sha256,
        loadedSequence: 5 + index,
        leaseAcquired: true,
        leaseAcquiredSequence: index,
        leaseReleased: true,
        leaseReleasedSequence: 21 + index,
      })),
    };
  };
  return {
    identity,
    contextIds,
    evaluationSequence: 1,
    firstContentSequence: 4,
    jsReadySequence: 12,
    firstContent: { ...identity },
    jsReady: { ...identity },
    confirmation,
    resources: LYNX_MATRIX_RESOURCE_PATHS.map((path, index) => ({
      path,
      sha256: build.files[path].sha256,
      loadedSequence: 5 + index,
      leaseAcquired: true,
      leaseAcquiredSequence: index,
      leaseReleased: true,
      leaseReleasedSequence: 21 + index,
    })),
    members: contextIds.map((memberContextId, index) =>
      makeMember(memberContextId, index === 0),
    ),
  };
}

function makeUnconfirmed(
  build: ReturnType<typeof makeBuild>,
  processId: string,
  generationId: string,
  contextId: string,
) {
  const launch = makeReady(build, processId, generationId, contextId);
  return {
    ...launch,
    jsReady: null,
    jsReadySequence: null,
    confirmation: null,
    readinessWithheld: true,
    members: launch.members.map((member) => ({
      ...member,
      jsReady: null,
      jsReadySequence: null,
      confirmation: null,
    })),
  };
}

function makeRecovery(
  kind: "fatal" | "unconfirmed",
  candidate: ReturnType<typeof makeBuild>,
  stable: ReturnType<typeof makeBuild>,
  suffix: string,
) {
  const failedProcessId = `${suffix}-failed-process`;
  const failedGenerationId = `${suffix}-failed-generation`;
  const failedContextId = `${suffix}-failed-context`;
  const failedAttemptId = `${failedContextId}-attempt`;
  const candidateLaunch = makeUnconfirmed(
    candidate,
    failedProcessId,
    failedGenerationId,
    failedContextId,
  );
  return {
    kind,
    candidate: {
      bundleId: candidate.bundleId,
      releaseId: candidate.releaseId,
    },
    failedAttemptId,
    failureEvent: {
      processId: failedProcessId,
      generationId: failedGenerationId,
      contextId:
        kind === "fatal" ? `${failedContextId}-secondary` : failedContextId,
      attemptId: failedAttemptId,
      bundleId: candidate.bundleId,
      releaseId: candidate.releaseId,
      ...(kind === "fatal"
        ? {
            event: "runtimeFailed",
            runtimeFailedSequence: 13,
            generationFailedSequence: 14,
          }
        : { event: "generationWillEvaluate" }),
    },
    candidateLaunch,
    ...(kind === "fatal"
      ? {
          generationRetirement: {
            contextIds: [failedContextId, `${failedContextId}-secondary`],
            leaseScope: "context",
            expectedLeaseCount: LYNX_MATRIX_RESOURCE_PATHS.length * 2,
            inFlightResourceCount: 0,
            willRetireSequence: 20,
            retiredSequence: 30,
            allLeasesBalanced: true,
            staleContextRejections: [],
            oldContextsInvalidated: false,
            lateOldContextEventCount: 0,
          },
        }
      : {}),
    recovered: makeReady(
      stable,
      kind === "fatal" ? failedProcessId : `${suffix}-recovered-process`,
      `${suffix}-recovered-generation`,
      `${suffix}-recovered-context`,
      transitionConfirmation("RECOVERED", candidate, stable),
    ),
    persistedExclusions: [
      kind === "fatal" ? candidate.bundleId : candidate.releaseId,
    ],
    candidateRetried: false,
  };
}

function makeCell(framework = "react", platform = "ios") {
  const A = makeBuild("A", "a");
  const B = makeBuild("B", "b");
  const C = makeBuild("C", "c");
  const fatal = makeBuild("FATAL", "d");
  const unconfirmed = makeBuild("UNCONFIRMED", "e");
  return {
    schemaVersion: "lynx-public-matrix-v1",
    cellId: `${framework}-${platform}`,
    framework,
    platform,
    commit: "0123456789abcdef",
    binary: {
      path: "/tmp/example.app",
      installedSha256: hash("f"),
      finalSha256: hash("f"),
    },
    builds: { A, B, C, fatal, unconfirmed },
    phases: {
      embeddedA: makeReady(A, "process-a", "generation-a", "context-a", {
        status: "CONFIRMED",
        transition: null,
      }),
      archiveB: {
        transport: "archive",
        archiveFallbackUsed: false,
        archiveSha256: hash("1"),
        stagedSelection: { bundleId: B.bundleId, releaseId: B.releaseId },
      },
      offline: {
        originProbe: {
          outcome: "connection-refused",
          url: "http://127.0.0.1:18791/health",
          observedAt: "2026-09-13T00:00:00.000Z",
        },
        activationB: makeReady(
          B,
          "process-b-activation",
          "generation-b-activation",
          "context-b-activation",
          transitionConfirmation("UPDATE_APPLIED", A, B),
        ),
        retainB: makeReady(
          B,
          "process-b-retain",
          "generation-b-retain",
          "context-b-retain",
        ),
        originStayedDown: true,
      },
      deltaC: {
        delivery: {
          transport: "bsdiff",
          algorithm: "bsdiff",
          transactionId: "install-transaction-c",
          baseBundleId: B.bundleId,
          targetBundleId: C.bundleId,
          archiveFallbackUsed: false,
          patchSha256: hash("2"),
          baseSha256: hash("3"),
          targetSha256: hash("4"),
          reconstructedSha256: hash("4"),
        },
        beforeReload: makeReady(
          B,
          "process-c",
          "generation-before",
          "context-before",
        ),
        afterReload: makeReady(
          C,
          "process-c",
          "generation-after",
          "context-after",
          transitionConfirmation("UPDATE_APPLIED", B, C),
        ),
        generationRetirement: {
          contextIds: ["context-before", "context-before-secondary"],
          leaseScope: "context",
          expectedLeaseCount: LYNX_MATRIX_RESOURCE_PATHS.length * 2,
          inFlightResourceCount: 0,
          willRetireSequence: 20,
          retiredSequence: 30,
          allLeasesBalanced: true,
          staleContextRejections: [
            {
              processId: "process-c",
              generationId: "generation-before",
              contextId: "context-before",
              attemptId: "context-before-attempt",
              bundleId: B.bundleId,
              releaseId: B.releaseId,
              code: "STALE_CONTEXT",
            },
            {
              processId: "process-c",
              generationId: "generation-before",
              contextId: "context-before-secondary",
              attemptId: "context-before-attempt",
              bundleId: B.bundleId,
              releaseId: B.releaseId,
              code: "STALE_CONTEXT",
            },
          ],
          oldContextsInvalidated: true,
          lateOldContextEventCount: 0,
        },
      },
      primaryLifecycle: {
        beforeRemoval: makeReady(
          C,
          "process-c",
          "generation-after",
          "context-after",
        ),
        generationRetirement: {
          contextIds: ["context-after", "context-after-secondary"],
          leaseScope: "context",
          expectedLeaseCount: LYNX_MATRIX_RESOURCE_PATHS.length * 2,
          inFlightResourceCount: 0,
          willRetireSequence: 20,
          retiredSequence: 30,
          allLeasesBalanced: true,
          staleContextRejections: [
            {
              processId: "process-c",
              generationId: "generation-after",
              contextId: "context-after",
              attemptId: "context-after-attempt",
              bundleId: C.bundleId,
              releaseId: C.releaseId,
              code: "STALE_CONTEXT",
            },
            {
              processId: "process-c",
              generationId: "generation-after",
              contextId: "context-after-secondary",
              attemptId: "context-after-attempt",
              bundleId: C.bundleId,
              releaseId: C.releaseId,
              code: "STALE_CONTEXT",
            },
          ],
          oldContextsInvalidated: true,
          lateOldContextEventCount: 0,
        },
        afterReplacement: makeReady(
          C,
          "process-c",
          "generation-primary-new",
          "context-primary-new",
        ),
      },
      fatalRecovery: makeRecovery("fatal", fatal, C, "fatal"),
      unconfirmedRecovery: makeRecovery(
        "unconfirmed",
        unconfirmed,
        C,
        "unconfirmed",
      ),
    },
    passed: true,
  };
}

describe("Lynx public matrix evidence contract", () => {
  it("accepts exact real-observation fields for one complete cell", () => {
    expect(() => validateLynxMatrixCell(makeCell())).not.toThrow();
  });

  it.each([
    [
      "a process restart during managed reload",
      (cell: any) => {
        cell.phases.deltaC.afterReload.identity.processId = "new-process";
        cell.phases.deltaC.afterReload.firstContent.processId = "new-process";
        cell.phases.deltaC.afterReload.jsReady.processId = "new-process";
      },
    ],
    [
      "a reused managed generation",
      (cell: any) => {
        cell.phases.deltaC.afterReload.identity.generationId =
          "generation-before";
        cell.phases.deltaC.afterReload.firstContent.generationId =
          "generation-before";
        cell.phases.deltaC.afterReload.jsReady.generationId =
          "generation-before";
      },
    ],
    [
      "a generation with no managed secondary",
      (cell: any) => {
        cell.phases.deltaC.beforeReload.contextIds = ["context-before"];
        cell.phases.deltaC.generationRetirement.contextIds = ["context-before"];
      },
    ],
    [
      "a secondary that claims confirmation authority",
      (cell: any) => {
        const secondary = cell.phases.embeddedA.members[1];
        secondary.readinessAuthority = true;
        secondary.jsReady = { ...secondary.identity };
        secondary.jsReadySequence = 12;
      },
    ],
    [
      "a secondary context reused after reload",
      (cell: any) => {
        cell.phases.deltaC.afterReload.contextIds[1] =
          "context-before-secondary";
      },
    ],
    [
      "a primary-removal replacement that reused the old generation",
      (cell: any) => {
        const replacement = cell.phases.primaryLifecycle.afterReplacement;
        replacement.identity.generationId = "generation-after";
        replacement.firstContent.generationId = "generation-after";
        replacement.jsReady.generationId = "generation-after";
      },
    ],
    [
      "a fatal event attributed to the primary context",
      (cell: any) => {
        cell.phases.fatalRecovery.failureEvent.contextId =
          cell.phases.fatalRecovery.candidateLaunch.identity.contextId;
      },
    ],
    [
      "a stranded secondary omitted from retirement",
      (cell: any) => {
        cell.phases.deltaC.generationRetirement.contextIds = ["context-before"];
      },
    ],
    [
      "an archive fallback presented as delta",
      (cell: any) => {
        cell.phases.deltaC.delivery.archiveFallbackUsed = true;
      },
    ],
    [
      "a screenshot-derived resource without lease evidence",
      (cell: any) => {
        delete cell.phases.deltaC.afterReload.resources[0].leaseReleased;
      },
    ],
    [
      "a mixed-release resource hash",
      (cell: any) => {
        cell.phases.offline.retainB.resources[1].sha256 = hash("9");
      },
    ],
    [
      "a first-content event from a stale context",
      (cell: any) => {
        cell.phases.embeddedA.firstContent.contextId = "stale-context";
      },
    ],
    [
      "first content observed after JS readiness",
      (cell: any) => {
        cell.phases.embeddedA.firstContentSequence = 13;
      },
    ],
    [
      "a required resource loaded after JS readiness",
      (cell: any) => {
        cell.phases.embeddedA.resources[0].loadedSequence = 14;
      },
    ],
    [
      "an old-generation lease released before retirement starts",
      (cell: any) => {
        cell.phases.deltaC.beforeReload.resources[0].leaseReleasedSequence = 19;
      },
    ],
    [
      "a secondary lease that did not drain during retirement",
      (cell: any) => {
        const resource =
          cell.phases.deltaC.beforeReload.members[1].resources[0];
        resource.leaseReleased = false;
        resource.leaseReleasedSequence = null;
      },
    ],
    [
      "a late old-context event count",
      (cell: any) => {
        cell.phases.deltaC.generationRetirement.lateOldContextEventCount = 1;
      },
    ],
    [
      "a missing retained-authority rejection",
      (cell: any) => {
        cell.phases.deltaC.generationRetirement.staleContextRejections.pop();
      },
    ],
    [
      "a generation-level lease claim for context-scoped host leases",
      (cell: any) => {
        cell.phases.deltaC.generationRetirement.leaseScope = "generation";
      },
    ],
    [
      "an in-flight resource request at generation retirement",
      (cell: any) => {
        cell.phases.deltaC.generationRetirement.inFlightResourceCount = 1;
      },
    ],
    [
      "a non-null embedded BUILTIN release",
      (cell: any) => {
        cell.builds.A.releaseId = "invented-release";
        cell.phases.embeddedA.identity.releaseId = "invented-release";
        cell.phases.embeddedA.firstContent.releaseId = "invented-release";
        cell.phases.embeddedA.jsReady.releaseId = "invented-release";
      },
    ],
    [
      "an origin that remained reachable",
      (cell: any) => {
        cell.phases.offline.originProbe.outcome = "http-200";
      },
    ],
    [
      "a changed native binary",
      (cell: any) => {
        cell.binary.finalSha256 = hash("0");
      },
    ],
    [
      "an unpersisted fatal exclusion",
      (cell: any) => {
        cell.phases.fatalRecovery.persistedExclusions = [];
      },
    ],
    [
      "byte-identical fatal and unconfirmed candidates",
      (cell: any) => {
        cell.builds.unconfirmed.bundleId = cell.builds.fatal.bundleId;
      },
    ],
    [
      "an UPDATE_APPLIED receipt that reports B to B",
      (cell: any) => {
        const confirmation = cell.phases.offline.activationB.confirmation;
        confirmation.transition.from = { ...confirmation.transition.to };
      },
    ],
    [
      "an UPDATE_APPLIED receipt whose target is not the launched candidate",
      (cell: any) => {
        const confirmation = cell.phases.deltaC.afterReload.confirmation;
        confirmation.transition.to.bundleId = cell.builds.B.bundleId;
        confirmation.transition.to.releaseId = cell.builds.B.releaseId;
      },
    ],
    [
      "historical failure evidence without a current native recovery receipt",
      (cell: any) => {
        const recovery = cell.phases.fatalRecovery.recovered;
        recovery.confirmation = {
          status: "ALREADY_CONFIRMED",
          transition: null,
        };
        recovery.members[0].confirmation = recovery.confirmation;
      },
    ],
    [
      "a RECOVERED receipt whose failed identity does not match the candidate",
      (cell: any) => {
        const confirmation =
          cell.phases.unconfirmedRecovery.recovered.confirmation;
        confirmation.transition.from.bundleId = cell.builds.fatal.bundleId;
        confirmation.transition.from.releaseId = cell.builds.fatal.releaseId;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const cell = makeCell();
    mutate(cell);
    expect(() => validateLynxMatrixCell(cell)).toThrow(
      "Invalid Lynx matrix receipt",
    );
  });

  it("requires exactly all six cells in a full summary", () => {
    const cells = expectedLynxMatrixCellIds().map((id) => {
      const [framework, platform] = id.split("-");
      return makeCell(framework, platform);
    });
    expect(() =>
      validateLynxMatrixSummary({
        schemaVersion: "lynx-public-matrix-summary-v1",
        cells,
        passed: true,
      }),
    ).not.toThrow();

    expect(() =>
      validateLynxMatrixSummary({
        schemaVersion: "lynx-public-matrix-summary-v1",
        cells: cells.slice(1),
        passed: true,
      }),
    ).toThrow("expected exactly");
  });
});
