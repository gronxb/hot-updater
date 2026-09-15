import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  expectedRawDetailNativeFailure,
  MISSING_ASSET_RESPONSE_SHA256,
} from "../../examples/lynx/scripts/public-matrix/raw-detail-rejection.mjs";
import { SPARKLING_NAVIGATION_PROVENANCE } from "../../packages/lynx/src/navigationProvenance";
import {
  expectedLynxMatrixCellIds,
  LYNX_MATRIX_ANDROID_SPARKLING_ARTIFACTS,
  LYNX_MATRIX_INCOMPATIBLE_RUNTIME_IDS,
  LYNX_MATRIX_IOS_SPARKLING_CHECKOUT,
  LYNX_MATRIX_NATIVE_VERSIONS,
  LYNX_MATRIX_PAGE_ENTRIES,
  LYNX_MATRIX_PAGE_ESSENTIAL_RESOURCES,
  LYNX_MATRIX_RESOURCE_PATHS,
  LYNX_MATRIX_RUNTIME_IDS,
  validateLynxMatrixCell,
  validateLynxMatrixSummary,
  validateLynxNativeArtifactsReceipt,
} from "./public-matrix-contract";

const hash = (value: string) => value.repeat(64).slice(0, 64);
const commit = "0123456789abcdef0123456789abcdef01234567";
const nativeConfigSha256 = (files: Record<string, string>) =>
  createHash("sha256")
    .update(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, digest]) => `${file}\0${digest}\n`)
        .join(""),
    )
    .digest("hex");

function diagnosticSummary(
  eventCount: number,
  oldestSequence: string | null,
  latestSequence: string | null,
  truncated: boolean,
  canonicalUtf8: string | null = null,
) {
  return {
    processId: "100",
    schemaVersion: 1,
    oldestSequence,
    latestSequence,
    truncated,
    eventCount,
    byteLength:
      canonicalUtf8 === null ? 4096 : Buffer.byteLength(canonicalUtf8),
    sha256:
      canonicalUtf8 === null
        ? hash("d")
        : createHash("sha256").update(canonicalUtf8).digest("hex"),
    canonicalUtf8,
  };
}

function makeNativeDiagnostics() {
  const stack = {
    orderedPageEntries: [
      "main.lynx.bundle",
      ...Array.from({ length: 15 }, () => "detail.lynx.bundle"),
    ],
    orderedPageParameters: Array.from({ length: 16 }, () => ({})),
    topPageEntry: "detail.lynx.bundle",
    topContextId: "stack-context-16",
  };
  const repair =
    '{"events":[],"nextSequence":"1","schemaVersion":1,"truncated":true}';
  const fixtures = [
    {
      mode: "retention-limit",
      installed: diagnosticSummary(256, "1", "256", false),
    },
    {
      mode: "count-plus-one",
      installed: diagnosticSummary(256, "2", "257", true),
      afterAppend: diagnosticSummary(256, "3", "258", true),
    },
    {
      mode: "byte-plus-one",
      installed: diagnosticSummary(255, "2", "256", true),
      afterAppend: diagnosticSummary(256, "2", "257", true),
    },
    ...["corrupt-json", "noncanonical", "already-oversized"].map((mode) => ({
      mode,
      installed: diagnosticSummary(0, null, null, true, repair),
      afterAppend: diagnosticSummary(1, "1", "1", true),
    })),
  ].map((item) => ({
    ...item,
    afterReopen: structuredClone(item.afterAppend ?? item.installed),
  }));
  return {
    navigationStackBoundary: {
      processId: "100",
      acceptedDepths: Array.from({ length: 15 }, (_, index) => index + 2),
      acceptedContextIds: Array.from(
        { length: 15 },
        (_, index) => `stack-context-${index + 2}`,
      ),
      rejectionCode: "STACK_LIMIT_EXCEEDED",
      before: {
        orderedPageEntries: ["main.lynx.bundle"],
        orderedPageParameters: [{}],
        topPageEntry: "main.lynx.bundle",
        topContextId: "context-a",
      },
      beforeRejected: stack,
      afterRejected: structuredClone(stack),
      nativeDepthBeforeRejected: 16,
      nativeDepthAfterRejected: 16,
    },
    runtimeEventFieldBoundaries: {
      processId: "100",
      result: {
        exactNameAccepted: true,
        namePlusOneRejected: true,
        exactDetailsAccepted: true,
        detailsPlusOneRejected: true,
        beforeLatestSequence: "10",
        afterLatestSequence: "12",
        acceptedSequenceCount: 2,
      },
      receipt: diagnosticSummary(12, "1", "12", false),
    },
    runtimeJournalFixtures: {
      processId: "100",
      fixtures,
      restored: diagnosticSummary(0, null, null, false),
    },
  };
}

function makeNativeArtifacts(
  platforms: readonly ("ios" | "android")[],
  binarySha256 = hash("f"),
  withPublicKeyInjection = true,
  target: "e2e" | "matrix" | "scaffold" = "matrix",
) {
  const targetDefinition = {
    e2e: {
      androidModule: "e2e-app",
      appId: "com.hotupdater.lynxexample",
      iosScheme: "SparklingGoE2E",
    },
    matrix: {
      androidModule: "matrix-app",
      appId: "com.hotupdater.lynxmatrix",
      iosScheme: "SparklingMatrixHarness",
    },
    scaffold: {
      androidModule: "app",
      appId: "com.hotupdater.lynxexample",
      iosScheme: "SparklingGo",
    },
  }[target];
  const nativePublicKeyFiles = {
    android: {
      "examples/lynx/android/app/src/main/AndroidManifest.xml": hash("6"),
      "examples/lynx/android/e2e-app/src/main/AndroidManifest.xml": hash("7"),
      "examples/lynx/android/matrix-app/src/main/AndroidManifest.xml":
        hash("8"),
    },
    ios: {
      "examples/lynx/ios/Info.plist": hash("9"),
      "examples/lynx/ios/MatrixHarness/NonProductionInfo.plist": hash("a"),
    },
  };
  const publicKeyIdentity = {
    schemaVersion: 1,
    provenance: "post-fingerprint-trust-anchor-injection",
    runtimeFingerprintRecalculated: false,
    algorithm: "rsa-spki",
    modulusLength: 2048,
    spkiSha256: hash("b"),
  };
  const nativeConfig = (platform: "ios" | "android") => {
    const basePaths =
      platform === "ios"
        ? [
            "examples/lynx/fingerprint.json",
            "examples/lynx/ios/Podfile",
            "examples/lynx/ios/Podfile.lock",
            "examples/lynx/ios/SparklingGo.xcodeproj/project.pbxproj",
            `examples/lynx/ios/SparklingGo.xcodeproj/xcshareddata/xcschemes/${targetDefinition.iosScheme}.xcscheme`,
          ]
        : [
            "examples/lynx/fingerprint.json",
            "examples/lynx/android/settings.gradle.kts",
            "examples/lynx/android/gradle.properties",
            `examples/lynx/android/${targetDefinition.androidModule}/build.gradle.kts`,
            "packages/lynx/android/build.gradle",
            "packages/lynx/android-sparkling/build.gradle",
          ];
    const files = {
      ...Object.fromEntries(
        basePaths.map((file, index) => [file, hash(String(index + 1))]),
      ),
      ...(withPublicKeyInjection ? nativePublicKeyFiles[platform] : {}),
    };
    return {
      sha256: nativeConfigSha256(files),
      files,
      ...(withPublicKeyInjection
        ? {
            nativePublicKeyInjection: {
              ...publicKeyIdentity,
              files: nativePublicKeyFiles[platform],
            },
          }
        : {}),
    };
  };
  return {
    schemaVersion: "lynx-native-artifacts-v2",
    target,
    appId: targetDefinition.appId,
    sourceCommit: commit,
    sourceIntegrity: {
      checkedCommit: commit,
      clean: true,
      trackedChanges: [],
      trackedTreeSha256: hash("e"),
      allowedTrackedChanges: [
        "examples-server/hono-kysely-pglite/hot-updater_migrations/migration_2026-09-11T14-30-47.sql",
        "examples-server/hono-kysely-pglite/src/db.ts",
        "examples-server/hono-kysely-pglite/src/localFsStorage.mjs",
        "examples-server/hono-kysely-pglite/src/localFsStorage.ts",
        "examples/lynx/.gitignore",
        "examples/lynx/scripts/e2e-kysely-deploy.mjs",
      ],
      ...(withPublicKeyInjection
        ? {
            nativePublicKeyInjection: {
              ...publicKeyIdentity,
              files: {
                ...nativePublicKeyFiles.android,
                ...nativePublicKeyFiles.ios,
              },
            },
          }
        : {}),
    },
    versions: { ...LYNX_MATRIX_NATIVE_VERSIONS },
    sparklingNavigation: { ...SPARKLING_NAVIGATION_PROVENANCE },
    artifacts: Object.fromEntries(
      platforms.map((platform) => [
        platform,
        {
          path:
            platform === "ios"
              ? "/tmp/SparklingMatrixHarness.app"
              : "/tmp/matrix-app-release.apk",
          sourceCommit: commit,
          appId: targetDefinition.appId,
          runtimeId: LYNX_MATRIX_RUNTIME_IDS[platform],
          binarySha256,
          artifactHashKind:
            platform === "ios"
              ? "deterministic-full-app-tree-v1"
              : "full-apk-bytes",
          nativeFingerprintSha256: hash("d"),
          nativeConfig: nativeConfig(platform),
          ...(platform === "ios"
            ? {
                scheme: targetDefinition.iosScheme,
                arch: "arm64",
                sparklingCheckout: { ...LYNX_MATRIX_IOS_SPARKLING_CHECKOUT },
              }
            : {
                task: `:${targetDefinition.androidModule}:assembleRelease`,
                abis: ["arm64-v8a"],
                sparklingArtifacts: {
                  ...LYNX_MATRIX_ANDROID_SPARKLING_ARTIFACTS,
                },
                sparklingDependencyGraphSha256:
                  "c68329c1968de962c8574f298ba46f43db016195bbbf4422b5e01145278aebe3",
              }),
        },
      ]),
    ),
  };
}

function makeBuild(variant: string, marker: string) {
  return {
    variant,
    compiler: "ReactLynx",
    compilerVersion: "0.116.5",
    runtimeId: "lynx-runtime",
    source: `/tmp/${variant.toLowerCase()}-compiler-output`,
    provenance: {
      framework: "ReactLynx",
      rspeedy: "0.116.5",
      sparklingNavigation: { ...SPARKLING_NAVIGATION_PROVENANCE },
    },
    bundleId: `${variant.toLowerCase()}-bundle`,
    releaseId: variant === "A" ? null : `${variant.toLowerCase()}-release`,
    manifestSha256: hash(marker),
    pageEntries: LYNX_MATRIX_PAGE_ENTRIES,
    pageEssentialResources: LYNX_MATRIX_PAGE_ESSENTIAL_RESOURCES,
    sparklingNavigation: { ...SPARKLING_NAVIGATION_PROVENANCE },
    files: Object.fromEntries(
      LYNX_MATRIX_RESOURCE_PATHS.map((path, index) => [
        path,
        { sha256: hash(String(index + 1)), byteSize: index + 1 },
      ]),
    ),
  };
}

function makeDelivery(
  base: ReturnType<typeof makeBuild>,
  target: ReturnType<typeof makeBuild>,
  marker: string,
) {
  return {
    transport: "bsdiff",
    algorithm: "bsdiff",
    transactionId: `install-transaction-${marker}`,
    baseBundleId: base.bundleId,
    targetBundleId: target.bundleId,
    archiveFallbackUsed: false,
    archiveFileHash: null,
    archiveFileUrl: null,
    deliveryArtifactUrl: `https://updates.test/artifacts/${target.bundleId}/from/${base.bundleId}`,
    manifestUrl: `https://updates.test/files/${target.bundleId}/manifest.json`,
    manifestSha256: target.manifestSha256,
    mainAssetPath: "main.lynx.bundle",
    mainFileUrl: `https://updates.test/files/${target.bundleId}/main.lynx.bundle`,
    patchUrl: `https://updates.test/files/${target.bundleId}/main.patch`,
    patchSha256: hash(marker),
    baseSha256: hash("a"),
    targetSha256: hash("b"),
    reconstructedSha256: hash("b"),
    rawDetailAssetPath: "detail.lynx.bundle",
    rawDetailFileUrl: `https://updates.test/files/${target.bundleId}/detail.lynx.bundle`,
    rawDetailSha256: target.files["detail.lynx.bundle"].sha256,
  };
}

function makeRawDetailRejections(
  target: ReturnType<typeof makeBuild>,
  running: ReturnType<typeof makeBuild>,
  platform: "ios" | "android",
) {
  return (["missing", "corrupt"] as const).map((mode, index) => {
    const failure = expectedRawDetailNativeFailure(platform, mode);
    return {
      mode,
      targetBundleId: target.bundleId,
      targetReleaseId: target.releaseId,
      rawDetailAssetPath: "detail.lynx.bundle",
      rawDetailFileUrl: `https://updates.test/files/${target.bundleId}/detail.lynx.bundle`,
      expectedSha256: target.files["detail.lynx.bundle"].sha256,
      actualAssetSha256: mode === "corrupt" ? hash("9") : null,
      requestUrl: `https://updates.test/files/${target.bundleId}/detail.lynx.bundle`,
      requestPath: `/files/${target.bundleId}/detail.lynx.bundle`,
      requestCountBefore: index,
      requestCountAfter: index + 1,
      consumedRequestCount: 1,
      responseStatus: mode === "missing" ? 404 : 200,
      responseSha256:
        mode === "corrupt" ? hash("9") : MISSING_ASSET_RESPONSE_SHA256,
      responseErrorCode: mode === "missing" ? "HTTP_404" : null,
      nativeInstallError: `Installation failed: [${failure.code}] ${failure.message}`,
      nativeInstallErrorCode: failure.code,
      nativeInstallErrorMessage: failure.message,
      nativeInstallErrorReceivedAt: "2026-09-14T00:00:00.000Z",
      nativeInstallErrorTransport: "matrix-control-http",
      archiveFileUrl: null,
      archiveFileHash: null,
      archiveFallbackUsed: false,
      runningBundleId: running.bundleId,
      runningReleaseId: running.releaseId,
      processId: "900",
      generationId: "generation-rejection",
      generationIdAfter: "generation-rejection",
      bundleIdAfter: running.bundleId,
      releaseIdAfter: running.releaseId,
      fallbackMarkerCountBefore: 0,
      fallbackMarkerCountAfter: 0,
      rejectedBeforeTransition: true,
    };
  });
}

function makeNavigationBoundaries(platform: string, sourceContextId: string) {
  return [
    "canonical-options",
    "parameter-count",
    "key-bytes",
    "value-bytes",
    "decoded-query-bytes",
    "raw-route-bytes",
  ].map((vector, index) => ({
    vector,
    acceptedContextId: `boundary-context-${index}`,
    nativePageClass:
      platform === "ios"
        ? "Sparkling.SPKViewController"
        : "com.hotupdater.lynx.sparkling.HotUpdaterSparklingPageActivity",
    sourceContextId,
    parameters: navigationBoundaryParameters(vector),
    acceptedOpenCount: 1,
    overflowNativeOpenCount: 0,
    closedToMain: true,
  }));
}

function navigationBoundaryParameters(vector: string) {
  if (vector === "canonical-options")
    return { title: "Second Page", value: "a+b" };
  if (vector === "parameter-count") {
    return Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`p${index}`, String(index)]),
    );
  }
  if (vector === "key-bytes") return { ["é".repeat(64)]: "ok" };
  if (vector === "value-bytes") return { value: "é".repeat(512) };
  if (vector === "decoded-query-bytes")
    return { a: "a".repeat(1_024), b: "b".repeat(998) };
  return { a: "é".repeat(512), b: "b".repeat(970) };
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
  reconstructedStack = false,
) {
  const identity = {
    runtimeId: build.runtimeId,
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
    const memberResourcePaths = primary
      ? LYNX_MATRIX_RESOURCE_PATHS.filter(
          (path) => path !== "detail.lynx.bundle",
        )
      : ["detail.lynx.bundle"];
    return {
      identity: memberIdentity,
      pageEntry: primary ? "main.lynx.bundle" : "detail.lynx.bundle",
      primary,
      readinessAuthority: primary,
      evaluationSequence: primary ? 1 : 2,
      firstContentSequence: 4,
      jsReadySequence: primary ? 12 : null,
      firstContent: { ...memberIdentity },
      jsReady: primary ? { ...memberIdentity } : null,
      pageAdmitted: primary ? null : { ...memberIdentity },
      pageAttemptTerminal: primary
        ? null
        : {
            ...memberIdentity,
            pageAttemptId: `${memberContextId}-page-attempt`,
            terminal: "admitted",
          },
      confirmation: primary ? confirmation : { status: "PAGE_ADMITTED" },
      nativePageClass: primary ? null : "Sparkling.SPKViewController",
      sourceContextId: primary ? null : identity.contextId,
      parameters: primary ? {} : { title: "Second Page" },
      resources: memberResourcePaths.map((path, index) => ({
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
    reconstructedStack,
    identity,
    contextIds,
    evaluationSequence: 1,
    firstContentSequence: 4,
    jsReadySequence: 12,
    firstContent: { ...identity },
    jsReady: { ...identity },
    confirmation,
    resources: LYNX_MATRIX_RESOURCE_PATHS.filter(
      (path) => path !== "detail.lynx.bundle",
    ).map((path, index) => ({
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
    detailReadinessWithheld: true,
    members: launch.members.map((member) =>
      member.primary
        ? {
            ...member,
            jsReady: null,
            jsReadySequence: null,
            confirmation: null,
          }
        : {
            ...member,
            pageAdmitted: null,
            pageAttemptTerminal: null,
            confirmation: null,
            pageAttemptId: `${member.identity.contextId}-page-attempt`,
          },
    ),
  };
}

function makeFatalPending(
  build: ReturnType<typeof makeBuild>,
  processId: string,
  generationId: string,
  contextId: string,
  primaryReady: boolean,
  fatal = true,
  confirmation?: any,
) {
  const launch = primaryReady
    ? makeReady(build, processId, generationId, contextId, confirmation)
    : makeUnconfirmed(build, processId, generationId, contextId);
  return {
    ...launch,
    readinessWithheld: !primaryReady,
    detailReadinessWithheld: true,
    ...(fatal ? { detailFailedBeforeAdmission: true } : {}),
    members: launch.members.map((member) =>
      member.primary
        ? member
        : {
            ...member,
            pageAdmitted: null,
            pageAttemptTerminal: null,
            confirmation: null,
            pageAttemptId: `${member.identity.contextId}-page-attempt`,
          },
    ),
  };
}

function makeRecovery(
  kind: "confirmed-interruption" | "fatal" | "unconfirmed",
  candidate: ReturnType<typeof makeBuild>,
  stable: ReturnType<typeof makeBuild>,
  suffix: string,
) {
  const processBase =
    kind === "fatal" ? 500 : kind === "confirmed-interruption" ? 600 : 700;
  const failedProcessId = String(processBase);
  const failedGenerationId = `${suffix}-failed-generation`;
  const failedContextId = `${suffix}-failed-context`;
  const failedAttemptId = `${failedContextId}-attempt`;
  const candidateLaunch =
    kind === "fatal"
      ? makeFatalPending(
          candidate,
          failedProcessId,
          failedGenerationId,
          failedContextId,
          false,
        )
      : kind === "confirmed-interruption"
        ? makeFatalPending(
            candidate,
            failedProcessId,
            failedGenerationId,
            failedContextId,
            true,
            false,
            transitionConfirmation("UPDATE_APPLIED", stable, candidate),
          )
        : makeUnconfirmed(
            candidate,
            failedProcessId,
            failedGenerationId,
            failedContextId,
          );
  const recovered = makeReady(
    stable,
    kind === "fatal" ? failedProcessId : String(processBase + 1),
    `${suffix}-recovered-generation`,
    `${suffix}-recovered-context`,
    transitionConfirmation("RECOVERED", candidate, stable),
  );
  recovered.evaluationSequence = 41;
  recovered.firstContentSequence = 44;
  recovered.jsReadySequence = 52;
  for (const [memberIndex, member] of recovered.members.entries()) {
    member.evaluationSequence = 41 + memberIndex;
    member.firstContentSequence = 44;
    if (member.primary) member.jsReadySequence = 52;
    for (const [resourceIndex, resource] of member.resources.entries()) {
      resource.leaseAcquiredSequence = 40 + resourceIndex;
      resource.loadedSequence = 45 + resourceIndex;
      resource.leaseReleasedSequence = 61 + resourceIndex;
    }
  }
  recovered.resources = recovered.members[0]!.resources;
  return {
    kind,
    candidate: {
      bundleId: candidate.bundleId,
      releaseId: candidate.releaseId,
    },
    failedAttemptId,
    failureEvent: {
      runtimeId: candidate.runtimeId,
      processId: failedProcessId,
      generationId: failedGenerationId,
      contextId: `${failedContextId}-secondary`,
      attemptId: failedAttemptId,
      bundleId: candidate.bundleId,
      releaseId: candidate.releaseId,
      ...(kind === "fatal"
        ? {
            event: "runtimeFailed",
            runtimeFailedSequence: 13,
            pageAttemptTerminalSequence: 14,
            generationFailedSequence: 15,
            pageAttemptTerminal: {
              runtimeId: candidate.runtimeId,
              processId: failedProcessId,
              generationId: failedGenerationId,
              contextId: `${failedContextId}-secondary`,
              attemptId: failedAttemptId,
              bundleId: candidate.bundleId,
              releaseId: candidate.releaseId,
              pageAttemptId: `${failedContextId}-secondary-page-attempt`,
              terminal: "verified-fatal",
            },
          }
        : {
            event: "pageAttemptTerminal",
            pageAttemptId: `${failedContextId}-secondary-page-attempt`,
            terminal: "process-interruption",
            terminalSequence: 13,
          }),
    },
    candidateLaunch,
    ...(kind === "fatal"
      ? {
          generationRetirement: {
            contextIds: [failedContextId, `${failedContextId}-secondary`],
            leaseScope: "context",
            expectedLeaseCount: LYNX_MATRIX_RESOURCE_PATHS.length,
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
    recovered,
    persistedExclusions: [
      kind === "fatal" ? candidate.bundleId : candidate.releaseId,
    ],
    ...(kind === "confirmed-interruption" ? { crashedBundleIds: [] } : {}),
    candidateRetried: false,
  };
}

function makeCell(framework = "react", platform = "ios") {
  const A = makeBuild("A", "a");
  const serverA = { ...makeBuild("A", "a"), releaseId: "a-release" };
  const B = makeBuild("B", "b");
  const C = makeBuild("C", "c");
  const confirmedInterruption = makeBuild("CONFIRMED_INTERRUPTION", "f");
  const fatal = makeBuild("FATAL", "d");
  const unconfirmed = makeBuild("UNCONFIRMED", "e");
  const incompatible = makeBuild("INCOMPATIBLE", "9");
  for (const build of [
    A,
    serverA,
    B,
    C,
    confirmedInterruption,
    fatal,
    unconfirmed,
  ]) {
    build.runtimeId = LYNX_MATRIX_RUNTIME_IDS[platform as "ios" | "android"];
  }
  incompatible.runtimeId =
    LYNX_MATRIX_INCOMPATIBLE_RUNTIME_IDS[platform as "ios" | "android"];
  return {
    schemaVersion: "lynx-public-matrix-v2",
    cellId: `${framework}-${platform}`,
    framework,
    platform,
    commit,
    binary: {
      path: "/tmp/example.app",
      installedSha256: hash("f"),
      finalSha256: hash("f"),
    },
    nativeArtifacts: makeNativeArtifacts([platform as "ios" | "android"]),
    builds: { A, serverA, B, C, confirmedInterruption, fatal, unconfirmed },
    diagnostics: {
      managedResourceEngineErrorCodes: [],
      ...makeNativeDiagnostics(),
      runtimeEventLedger: {
        schemaVersion: "lynx-generation-event-ledger-v1",
        oldestSequence: "1",
        latestSequence: "80",
        eventCount: 80,
        sha256: hash("e"),
        checkpoints: Array.from({ length: 8 }, (_, index) => ({
          stage: `phase-${index}`,
          oldestSequence: "1",
          latestSequence: String((index + 1) * 10),
          truncated: false,
          snapshotSha256: hash("a"),
          ledgerSha256: index === 7 ? hash("e") : hash("b"),
        })),
      },
    },
    phases: {
      embeddedA: makeReady(A, "100", "generation-a", "context-a", {
        status: "CONFIRMED",
        transition: null,
      }),
      navigationBoundaries: makeNavigationBoundaries(platform, "context-a"),
      crossProvenance: {
        build: incompatible,
        rejection: {
          candidate: {
            bundleId: incompatible.bundleId,
            releaseId: incompatible.releaseId,
            runtimeId: incompatible.runtimeId,
            manifestSha256: incompatible.manifestSha256,
            artifactUrl: "https://updates.test/files/incompatible/archive.zip",
          },
          running: {
            bundleId: C.bundleId,
            releaseId: C.releaseId,
            runtimeId: C.runtimeId,
            processId: "300",
            generationId: "generation-after",
          },
          nativeErrorCode: "INCOMPATIBLE",
          rejectedBeforeGenerationEvaluation: true,
          firstArtifactRequestCount: 1,
          cachedArtifactRequestCount: 0,
        },
      },
      deltaB: {
        delivery: makeDelivery(A, B, "1"),
        rawDetailRejections: makeRawDetailRejections(B, A, platform),
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
          "200",
          "generation-b-activation",
          "context-b-activation",
          transitionConfirmation("UPDATE_APPLIED", A, B),
        ),
        retainB: makeReady(B, "201", "generation-b-retain", "context-b-retain"),
        originStayedDown: true,
      },
      deltaC: {
        delivery: makeDelivery(B, C, "2"),
        rawDetailRejections: makeRawDetailRejections(C, B, platform),
        beforeReload: makeReady(
          B,
          "300",
          "generation-before",
          "context-before",
        ),
        afterReload: makeReady(
          C,
          "300",
          "generation-after",
          "context-after",
          transitionConfirmation("UPDATE_APPLIED", B, C),
          true,
        ),
        generationRetirement: {
          contextIds: ["context-before", "context-before-secondary"],
          leaseScope: "context",
          expectedLeaseCount: LYNX_MATRIX_RESOURCE_PATHS.length,
          inFlightResourceCount: 0,
          willRetireSequence: 20,
          retiredSequence: 30,
          allLeasesBalanced: true,
          staleContextRejections: [
            {
              runtimeId: B.runtimeId,
              processId: "300",
              generationId: "generation-before",
              contextId: "context-before",
              attemptId: "context-before-attempt",
              bundleId: B.bundleId,
              releaseId: B.releaseId,
              code: "STALE_CONTEXT",
            },
            {
              runtimeId: B.runtimeId,
              processId: "300",
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
        beforeRemoval: makeReady(C, "300", "generation-after", "context-after"),
        generationRetirement: {
          contextIds: ["context-after", "context-after-secondary"],
          leaseScope: "context",
          expectedLeaseCount: LYNX_MATRIX_RESOURCE_PATHS.length,
          inFlightResourceCount: 0,
          willRetireSequence: 20,
          retiredSequence: 30,
          allLeasesBalanced: true,
          staleContextRejections: [
            {
              runtimeId: C.runtimeId,
              processId: "300",
              generationId: "generation-after",
              contextId: "context-after",
              attemptId: "context-after-attempt",
              bundleId: C.bundleId,
              releaseId: C.releaseId,
              code: "STALE_CONTEXT",
            },
            {
              runtimeId: C.runtimeId,
              processId: "300",
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
          "300",
          "generation-primary-new",
          "context-primary-new",
        ),
      },
      pendingManagedTransition: {
        before: makeReady(
          C,
          "300",
          "generation-primary-new",
          "context-primary-new",
        ),
        after: makeReady(
          C,
          "300",
          "generation-pending-new",
          "context-pending-new",
          undefined,
          true,
        ),
        receipt: {
          processId: "300",
          bundleId: C.bundleId,
          releaseId: C.releaseId,
          sourceGenerationId: "generation-primary-new",
          pendingPageAttemptId: "pending-old-attempt",
          terminal: "authorized-cancel",
          reason: "managedTransition",
          transitionId: "pending-transition",
          targetGenerationId: "generation-pending-new",
          reconstructedPageAttemptId: "pending-new-attempt",
          orderedPageEntries: ["main.lynx.bundle", "detail.lynx.bundle"],
          orderedPageParameters: [
            [],
            [{ name: "title", value: "Second Page" }],
          ],
          topPageEntry: "detail.lynx.bundle",
          sourceContextId: "context-primary-new",
          nativePageClass:
            platform === "ios"
              ? "Sparkling.SPKViewController"
              : "com.hotupdater.lynx.sparkling.HotUpdaterSparklingPageActivity",
        },
      },
      confirmedDetailFatal: {
        beforeFailure: makeFatalPending(
          C,
          "300",
          "generation-pending-new",
          "context-pending-new",
          true,
        ),
        failureEvent: {
          runtimeId: C.runtimeId,
          processId: "300",
          generationId: "generation-pending-new",
          contextId: "context-pending-new-secondary",
          attemptId: "context-pending-new-attempt",
          bundleId: C.bundleId,
          releaseId: C.releaseId,
          event: "runtimeFailed",
          runtimeFailedSequence: 13,
          pageAttemptTerminalSequence: 14,
          generationFailedSequence: 15,
          pageAttemptTerminal: {
            runtimeId: C.runtimeId,
            processId: "300",
            generationId: "generation-pending-new",
            contextId: "context-pending-new-secondary",
            attemptId: "context-pending-new-attempt",
            bundleId: C.bundleId,
            releaseId: C.releaseId,
            pageAttemptId: "context-pending-new-secondary-page-attempt",
            terminal: "verified-fatal",
          },
        },
        generationRetirement: {
          contextIds: ["context-pending-new", "context-pending-new-secondary"],
          leaseScope: "context",
          expectedLeaseCount: LYNX_MATRIX_RESOURCE_PATHS.length,
          inFlightResourceCount: 0,
          willRetireSequence: 20,
          retiredSequence: 30,
          allLeasesBalanced: true,
          staleContextRejections: [],
          oldContextsInvalidated: false,
          lateOldContextEventCount: 0,
        },
        recovered: makeReady(
          C,
          "300",
          "generation-confirmed-fatal-recovery",
          "context-confirmed-fatal-recovery",
        ),
      },
      confirmedInterruptionRecovery: makeRecovery(
        "confirmed-interruption",
        confirmedInterruption,
        C,
        "confirmed-interruption",
      ),
      fatalRecovery: makeRecovery("fatal", fatal, C, "fatal"),
      unconfirmedRecovery: makeRecovery(
        "unconfirmed",
        unconfirmed,
        C,
        "unconfirmed",
      ),
      reverseRollback: {
        cToB: {
          delivery: makeDelivery(C, B, "3"),
          rawDetailRejections: makeRawDetailRejections(B, C, platform),
          launch: makeReady(
            B,
            "400",
            "generation-rollback-b",
            "context-rollback-b",
            transitionConfirmation("UPDATE_APPLIED", C, B),
          ),
        },
        bToA: {
          delivery: makeDelivery(B, serverA, "4"),
          rawDetailRejections: makeRawDetailRejections(serverA, B, platform),
          launch: makeReady(
            serverA,
            "400",
            "generation-rollback-a",
            "context-rollback-a",
            transitionConfirmation("UPDATE_APPLIED", B, serverA),
          ),
        },
      },
    },
    passed: true,
  };
}

describe("Lynx public matrix evidence contract", () => {
  it("accepts exact real-observation fields for one complete cell", () => {
    expect(() => validateLynxMatrixCell(makeCell())).not.toThrow();
  });

  it("accepts a clean native receipt with no public-key injection", () => {
    const cell = makeCell();
    cell.nativeArtifacts = makeNativeArtifacts(["ios"], hash("f"), false);

    expect(() => validateLynxMatrixCell(cell)).not.toThrow();
  });

  it.each(["scaffold", "e2e", "matrix"] as const)(
    "accepts the exact %s native config path sets",
    (target) => {
      const appId =
        target === "matrix"
          ? "com.hotupdater.lynxmatrix"
          : "com.hotupdater.lynxexample";
      const receipt = makeNativeArtifacts(
        ["ios", "android"],
        hash("f"),
        true,
        target,
      );

      expect(() =>
        validateLynxNativeArtifactsReceipt(receipt, {
          appId,
          commit,
          platforms: ["ios", "android"],
          target,
        }),
      ).not.toThrow();
    },
  );

  it.each([
    [
      "a build that drops compiler page metadata",
      (cell: any) => {
        delete cell.builds.C.pageEssentialResources;
      },
    ],
    [
      "a build that rewrites Sparkling navigation provenance",
      (cell: any) => {
        cell.builds.C.sparklingNavigation.gitTagCommit = "unverified";
      },
    ],
    [
      "a build that drops compiler source provenance",
      (cell: any) => {
        delete cell.builds.B.source;
      },
    ],
    [
      "a confirmed launch with a managed-resource engine error",
      (cell: any) => {
        cell.diagnostics.managedResourceEngineErrorCodes = [301];
      },
    ],
    [
      "a process restart during managed reload",
      (cell: any) => {
        cell.phases.deltaC.afterReload.identity.processId = "301";
        cell.phases.deltaC.afterReload.firstContent.processId = "301";
        cell.phases.deltaC.afterReload.jsReady.processId = "301";
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
      "a detail page without the real route params",
      (cell: any) => {
        cell.phases.embeddedA.members[1].parameters.title = "guessed";
      },
    ],
    [
      "an admitted detail without its durable terminal record",
      (cell: any) => {
        cell.phases.embeddedA.members[1].pageAttemptTerminal = null;
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
      "an archive URL retained beside a claimed manifest-only delta",
      (cell: any) => {
        cell.phases.deltaB.delivery.archiveFileUrl =
          "https://example.invalid/archive";
      },
    ],
    [
      "a cached rollback selection without native reverse patch evidence",
      (cell: any) => {
        delete cell.phases.reverseRollback.cToB.delivery;
      },
    ],
    [
      "a reverse patch that omits the raw detail target",
      (cell: any) => {
        delete cell.phases.reverseRollback.bToA.delivery.rawDetailSha256;
      },
    ],
    [
      "a delta receipt that drops the immutable patch URL",
      (cell: any) => {
        delete cell.phases.deltaC.delivery.patchUrl;
      },
    ],
    [
      "a reverse target that skips corrupt raw-detail rejection",
      (cell: any) => {
        cell.phases.reverseRollback.cToB.rawDetailRejections.pop();
      },
    ],
    [
      "a raw-detail rejection with a manufactured request URL",
      (cell: any) => {
        cell.phases.deltaC.rawDetailRejections[0].requestUrl =
          "https://updates.test/files/unrelated/detail.lynx.bundle";
      },
    ],
    [
      "a corrupt raw-detail rejection without the served mutated hash",
      (cell: any) => {
        const rejection = cell.phases.deltaC.rawDetailRejections.find(
          (item: any) => item.mode === "corrupt",
        );
        rejection.responseSha256 = hash("7");
      },
    ],
    [
      "a missing raw-detail rejection without proxy consumption",
      (cell: any) => {
        const rejection = cell.phases.deltaC.rawDetailRejections.find(
          (item: any) => item.mode === "missing",
        );
        rejection.consumedRequestCount = 0;
        rejection.requestCountAfter = rejection.requestCountBefore;
      },
    ],
    [
      "a raw-detail rejection with only a generic UI error",
      (cell: any) => {
        const rejection = cell.phases.deltaC.rawDetailRejections[0];
        rejection.nativeInstallError = "Installation failed: generic";
      },
    ],
    [
      "a raw-detail rejection attributed only to console output",
      (cell: any) => {
        const rejection = cell.phases.deltaC.rawDetailRejections[0];
        rejection.nativeInstallErrorTransport = "console";
      },
    ],
    [
      "a raw-detail rejection with the wrong native error code",
      (cell: any) => {
        const rejection = cell.phases.deltaC.rawDetailRejections[1];
        rejection.nativeInstallErrorCode = "NATIVE_ERROR";
      },
    ],
    [
      "a missing raw-detail rejection with an unbound response body hash",
      (cell: any) => {
        const rejection = cell.phases.deltaC.rawDetailRejections[0];
        rejection.responseSha256 = hash("8");
      },
    ],
    [
      "a pending transition using the process-interruption terminal",
      (cell: any) => {
        cell.phases.pendingManagedTransition.receipt.terminal =
          "process-interruption";
      },
    ],
    [
      "a package event checkpoint whose truncation hides a sequence gap",
      (cell: any) => {
        const checkpoints = cell.diagnostics.runtimeEventLedger.checkpoints;
        checkpoints[1].truncated = true;
        checkpoints[1].oldestSequence = "12";
      },
    ],
    [
      "a native depth-17 attempt that mutated the packaged stack",
      (cell: any) => {
        cell.diagnostics.navigationStackBoundary.nativeDepthAfterRejected = 17;
      },
    ],
    [
      "a repaired runtime journal with noncanonical persisted bytes",
      (cell: any) => {
        const fixture = cell.diagnostics.runtimeJournalFixtures.fixtures.find(
          (item: any) => item.mode === "noncanonical",
        );
        fixture.installed.canonicalUtf8 += "\n";
      },
    ],
    [
      "a cell binary that is not the bound native artifact",
      (cell: any) => {
        cell.nativeArtifacts.artifacts.ios.binarySha256 = hash("0");
      },
    ],
    [
      "a runnable native artifact built from dirty tracked source",
      (cell: any) => {
        cell.nativeArtifacts.sourceIntegrity.trackedChanges = [
          "examples/lynx/ios/Info.plist",
        ];
      },
    ],
    [
      "a native config injection without source provenance",
      (cell: any) => {
        delete cell.nativeArtifacts.sourceIntegrity.nativePublicKeyInjection;
      },
    ],
    [
      "source provenance without a native config injection",
      (cell: any) => {
        delete cell.nativeArtifacts.artifacts.ios.nativeConfig
          .nativePublicKeyInjection;
      },
    ],
    [
      "a native config bound to another SPKI key",
      (cell: any) => {
        cell.nativeArtifacts.artifacts.ios.nativeConfig.nativePublicKeyInjection.spkiSha256 =
          hash("0");
      },
    ],
    [
      "a native config file hash that differs from source integrity",
      (cell: any) => {
        cell.nativeArtifacts.artifacts.ios.nativeConfig.files[
          "examples/lynx/ios/Info.plist"
        ] = hash("0");
      },
    ],
    [
      "a native config aggregate digest that does not match its files",
      (cell: any) => {
        cell.nativeArtifacts.artifacts.ios.nativeConfig.sha256 = hash("0");
      },
    ],
    [
      "a native config with an extra path",
      (cell: any) => {
        cell.nativeArtifacts.artifacts.ios.nativeConfig.files[
          "examples/lynx/ios/Unbound.xcconfig"
        ] = hash("0");
      },
    ],
    [
      "a native config with a missing base path",
      (cell: any) => {
        delete cell.nativeArtifacts.artifacts.ios.nativeConfig.files[
          "examples/lynx/ios/Podfile.lock"
        ];
      },
    ],
    [
      "a native config with a substituted base path",
      (cell: any) => {
        const files = cell.nativeArtifacts.artifacts.ios.nativeConfig.files;
        delete files["examples/lynx/ios/Podfile.lock"];
        files["examples/lynx/ios/Podfile.resolved"] = hash("0");
      },
    ],
    [
      "a native artifact whose application ID was not derived from the package",
      (cell: any) => {
        cell.nativeArtifacts.artifacts.ios.appId =
          "com.hotupdater.manufactured";
      },
    ],
    [
      "an iOS native receipt that hashes only the executable",
      (cell: any) => {
        cell.nativeArtifacts.artifacts.ios.artifactHashKind = "executable-only";
      },
    ],
    [
      "a cross-provenance candidate that matches the running runtime",
      (cell: any) => {
        cell.phases.crossProvenance.build.runtimeId =
          LYNX_MATRIX_RUNTIME_IDS.ios;
      },
    ],
    [
      "a cross-provenance candidate redownloaded after native rejection",
      (cell: any) => {
        cell.phases.crossProvenance.rejection.cachedArtifactRequestCount = 1;
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
      "a reverse rollback that reuses the B generation",
      (cell: any) => {
        const rollback = cell.phases.reverseRollback;
        rollback.bToA.launch.identity.generationId =
          rollback.cToB.launch.identity.generationId;
        rollback.bToA.launch.firstContent.generationId =
          rollback.cToB.launch.identity.generationId;
        rollback.bToA.launch.jsReady.generationId =
          rollback.cToB.launch.identity.generationId;
      },
    ],
    [
      "an unpersisted fatal exclusion",
      (cell: any) => {
        cell.phases.fatalRecovery.persistedExclusions = [];
      },
    ],
    [
      "an obsolete fatal terminal spelling",
      (cell: any) => {
        cell.phases.fatalRecovery.failureEvent.pageAttemptTerminal.terminal =
          "fatal";
      },
    ],
    [
      "a replayed fatal event whose runtime origin changed",
      (cell: any) => {
        const failure = cell.phases.fatalRecovery.failureEvent;
        failure.runtimeId = `${cell.builds.fatal.runtimeId}-invented`;
        failure.pageAttemptTerminal.runtimeId = failure.runtimeId;
      },
    ],
    [
      "an interruption recorded as an obsolete terminal spelling",
      (cell: any) => {
        cell.phases.unconfirmedRecovery.failureEvent.terminal = "interrupted";
      },
    ],
    [
      "a process interruption added to Bundle crash history",
      (cell: any) => {
        const phase = cell.phases.confirmedInterruptionRecovery;
        phase.crashedBundleIds = [phase.candidate.bundleId];
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
    const nativeArtifacts = makeNativeArtifacts(["ios", "android"]);
    const cells = expectedLynxMatrixCellIds().map((id) => {
      const [framework, platform] = id.split("-");
      return {
        ...makeCell(framework, platform),
        nativeArtifacts,
      };
    });
    expect(() =>
      validateLynxMatrixSummary({
        schemaVersion: "lynx-public-matrix-summary-v2",
        commit,
        nativeArtifacts,
        cells,
        passed: true,
      }),
    ).not.toThrow();

    expect(() =>
      validateLynxMatrixSummary({
        schemaVersion: "lynx-public-matrix-summary-v2",
        commit,
        nativeArtifacts,
        cells: cells.slice(1),
        passed: true,
      }),
    ).toThrow("expected exactly");
  });
});
