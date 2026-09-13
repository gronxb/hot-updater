import assert from "node:assert/strict";

export const resourcePaths = [
  "main.lynx.bundle",
  "assets/probe.png",
  "assets/probe.ttf",
  "assets/bootstrap.js",
  "dynamic/component.lynx.bundle",
];

const completionEvent = (path) => {
  if (path === "assets/probe.png") return "imageLoaded";
  if (path === "assets/probe.ttf") return "fontLoaded";
  return "resourceLoaded";
};

const value = (input) => (input == null ? null : String(input));

function sameIdentity(event, identity) {
  return (
    value(event.processId) === identity.processId &&
    value(event.generationId) === identity.generationId &&
    value(event.contextId) === identity.contextId &&
    value(event.attemptId) === identity.attemptId &&
    value(event.bundleId) === identity.bundleId &&
    value(event.releaseId) === identity.releaseId
  );
}

function sameGenerationSelection(event, identity) {
  return (
    value(event.processId) === identity.processId &&
    value(event.generationId) === identity.generationId &&
    value(event.bundleId) === identity.bundleId &&
    value(event.releaseId) === identity.releaseId
  );
}

function requireEvent(events, name, predicate, description) {
  const event = events.find(
    (candidate) => candidate.event === name && predicate(candidate),
  );
  assert.ok(event, `Missing ${description ?? name} matrix event`);
  return event;
}

function eventSequence(events, event) {
  const encoded = JSON.stringify(event);
  const sequence = events.findIndex(
    (candidate) => JSON.stringify(candidate) === encoded,
  );
  assert.ok(
    sequence >= 0,
    `Event is absent from retained evidence: ${encoded}`,
  );
  return sequence;
}

export function eventIdentity(event) {
  assert.ok(
    Object.hasOwn(event, "releaseId"),
    `Matrix event is missing releaseId: ${JSON.stringify(event)}`,
  );
  const identity = {
    processId: value(event.processId),
    generationId: value(event.generationId),
    contextId: value(event.contextId ?? event.primaryContextId),
    attemptId: value(event.attemptId),
    bundleId: value(event.bundleId),
    releaseId: value(event.releaseId),
  };
  for (const [name, observed] of Object.entries(identity)) {
    if (name === "releaseId") continue;
    assert.ok(
      observed,
      `Matrix event is missing ${name}: ${JSON.stringify(event)}`,
    );
  }
  return identity;
}

function hasCompleteLaunchEvents(events, build, processId, requireReady) {
  const started = events.find(
    (event) =>
      event.event === "generationStarted" &&
      value(event.processId) === String(processId) &&
      value(event.bundleId) === build.bundleId &&
      value(event.releaseId) === build.releaseId &&
      Array.isArray(event.contextIds) &&
      event.contextIds.length >= 2,
  );
  if (!started) return false;
  let identity;
  try {
    identity = eventIdentity(started);
  } catch {
    return false;
  }
  return started.contextIds.map(String).every((contextId) => {
    const memberIdentity = { ...identity, contextId };
    const primary = contextId === identity.contextId;
    const hasFirstContent = events.some(
      (event) =>
        event.event === "firstContent" && sameIdentity(event, memberIdentity),
    );
    const hasReady = events.some(
      (event) =>
        event.event === "jsReady" && sameIdentity(event, memberIdentity),
    );
    return (
      hasFirstContent &&
      hasReady === (primary && requireReady) &&
      events.some(
        (event) =>
          event.event === "generationWillEvaluate" &&
          event.primary === primary &&
          sameIdentity(event, memberIdentity),
      ) &&
      resourcePaths.every((path) =>
        events.some(
          (event) =>
            event.event === completionEvent(path) &&
            event.path === path &&
            sameIdentity(event, memberIdentity),
        ),
      )
    );
  });
}

export function hasCompleteReadyEvents(events, build, processId) {
  return hasCompleteLaunchEvents(events, build, processId, true);
}

export function hasCompleteUnconfirmedEvents(events, build, processId) {
  return hasCompleteLaunchEvents(events, build, processId, false);
}

export function validateAttributedDiagnostics(events) {
  const contextEvents = new Set([
    "generationFailed",
    "runtimeFailed",
    "staleReloadRejected",
    "staleRecoveryRejected",
    "staleContentRejected",
    "staleContextRejected",
    "contextRejected",
  ]);
  for (const event of events) {
    if (contextEvents.has(event.event)) eventIdentity(event);
    if (event.event !== "generationReconstructionFailed") continue;
    assert.ok(
      Object.hasOwn(event, "releaseId"),
      "generationReconstructionFailed is missing releaseId",
    );
    for (const name of [
      "processId",
      "generationId",
      "attemptId",
      "bundleId",
      "reason",
      "message",
    ]) {
      assert.ok(
        value(event[name]),
        `generationReconstructionFailed is missing ${name}`,
      );
    }
    assert.ok(
      Array.isArray(event.contextIds) &&
        event.contextIds.length >= 2 &&
        event.contextIds.length === new Set(event.contextIds.map(String)).size,
      "generationReconstructionFailed must declare the exact managed contextIds",
    );
  }
}

export function collectSecondaryFatalFailure(events, candidateLaunch) {
  const runtimeFailed = requireEvent(
    events,
    "runtimeFailed",
    (event) =>
      value(event.processId) === candidateLaunch.identity.processId &&
      value(event.generationId) === candidateLaunch.identity.generationId &&
      value(event.attemptId) === candidateLaunch.identity.attemptId &&
      value(event.bundleId) === candidateLaunch.identity.bundleId &&
      value(event.releaseId) === candidateLaunch.identity.releaseId &&
      value(event.contextId) !== candidateLaunch.identity.contextId &&
      candidateLaunch.contextIds.includes(value(event.contextId)),
    "secondary runtimeFailed",
  );
  const failureIdentity = eventIdentity(runtimeFailed);
  const recorded = requireEvent(
    events,
    "generationFailed",
    (event) => sameIdentity(event, failureIdentity),
    "generationFailed attributed to the secondary runtime failure",
  );
  const runtimeFailedSequence = eventSequence(events, runtimeFailed);
  const generationFailedSequence = eventSequence(events, recorded);
  assert.ok(
    runtimeFailedSequence < generationFailedSequence,
    "runtimeFailed must precede generationFailed",
  );
  return {
    ...failureIdentity,
    event: "runtimeFailed",
    runtimeFailedSequence,
    generationFailedSequence,
  };
}

function collectLaunchEvidence({
  phaseEvents,
  allEvents,
  build,
  processId,
  requireReady,
}) {
  const started = requireEvent(
    phaseEvents,
    "generationStarted",
    (event) =>
      value(event.processId) === String(processId) &&
      value(event.bundleId) === build.bundleId &&
      value(event.releaseId) === build.releaseId,
    `generationStarted for ${build.variant}`,
  );
  const identity = eventIdentity(started);
  assert.ok(
    Array.isArray(started.contextIds),
    "generationStarted must declare its final context membership",
  );
  const contextIds = started.contextIds.map(String);
  assert.ok(
    contextIds.length >= 2 && contextIds.length === new Set(contextIds).size,
    "generationStarted must declare a unique primary and managed secondary",
  );
  assert.ok(
    contextIds.includes(identity.contextId),
    "Primary context is absent from generationStarted.contextIds",
  );
  const evaluatedContextIds = [
    ...new Set(
      phaseEvents
        .filter(
          (event) =>
            event.event === "generationWillEvaluate" &&
            sameGenerationSelection(event, identity),
        )
        .map((event) => value(event.contextId))
        .filter(Boolean),
    ),
  ];
  assert.deepEqual(
    [...evaluatedContextIds].sort(),
    [...contextIds].sort(),
    "generationStarted.contextIds must exactly match evaluated contexts",
  );
  const members = contextIds.map((contextId) => {
    const memberIdentity = { ...identity, contextId };
    const primary = contextId === identity.contextId;
    const evaluation = requireEvent(
      phaseEvents,
      "generationWillEvaluate",
      (event) =>
        sameIdentity(event, memberIdentity) && event.primary === primary,
      `generationWillEvaluate for ${build.variant} ${contextId}`,
    );
    const firstContentEvent = requireEvent(
      phaseEvents,
      "firstContent",
      (event) => sameIdentity(event, memberIdentity),
      `firstContent for ${build.variant} ${contextId}`,
    );
    const jsReadyEvent = phaseEvents.find(
      (event) =>
        event.event === "jsReady" && sameIdentity(event, memberIdentity),
    );
    if (primary && requireReady) {
      assert.ok(
        jsReadyEvent,
        `Missing jsReady for ${build.variant} ${contextId}`,
      );
    } else {
      assert.equal(
        jsReadyEvent,
        undefined,
        `${primary ? "Unconfirmed primary" : "Secondary"} ${build.variant} ${contextId} unexpectedly emitted jsReady`,
      );
    }
    const resources = resourcePaths.map((path) => {
      const loaded = phaseEvents.find(
        (event) =>
          event.event === completionEvent(path) &&
          event.path === path &&
          sameIdentity(event, memberIdentity),
      );
      assert.ok(
        loaded,
        `Missing successful resource completion for ${build.variant} ${contextId} ${path}`,
      );
      const acquired = requireEvent(
        allEvents,
        "resourceLeaseAcquired",
        (event) =>
          event.path === path &&
          value(event.sha256) === value(loaded.sha256) &&
          sameIdentity(event, memberIdentity),
        `resourceLeaseAcquired for ${build.variant} ${contextId} ${path}`,
      );
      const acquiredSequence = eventSequence(allEvents, acquired);
      const releasedSequence = allEvents.findIndex(
        (event, index) =>
          index > acquiredSequence &&
          event.event === "resourceLeaseReleased" &&
          event.path === path &&
          value(event.sha256) === value(loaded.sha256) &&
          sameIdentity(event, memberIdentity),
      );
      return {
        path,
        sha256: value(loaded.sha256),
        loadedSequence: eventSequence(allEvents, loaded),
        leaseAcquired: true,
        leaseReleased: releasedSequence >= 0,
        leaseAcquiredSequence: acquiredSequence,
        leaseReleasedSequence: releasedSequence >= 0 ? releasedSequence : null,
      };
    });
    return {
      identity: memberIdentity,
      primary,
      readinessAuthority: primary,
      evaluationSequence: eventSequence(allEvents, evaluation),
      firstContentSequence: eventSequence(allEvents, firstContentEvent),
      jsReadySequence: jsReadyEvent
        ? eventSequence(allEvents, jsReadyEvent)
        : null,
      firstContent: eventIdentity(firstContentEvent),
      jsReady: jsReadyEvent ? eventIdentity(jsReadyEvent) : null,
      confirmation: jsReadyEvent?.confirmation ?? null,
      resources,
    };
  });
  const primaryMember = members.find((member) => member.primary);
  assert.ok(primaryMember);
  return {
    identity,
    contextIds,
    evaluationSequence: primaryMember.evaluationSequence,
    firstContentSequence: primaryMember.firstContentSequence,
    jsReadySequence: primaryMember.jsReadySequence,
    firstContent: primaryMember.firstContent,
    jsReady: primaryMember.jsReady,
    confirmation: primaryMember.confirmation,
    resources: primaryMember.resources,
    members,
    readinessWithheld: !requireReady,
  };
}

export function collectReadyLaunch(input) {
  return collectLaunchEvidence({ ...input, requireReady: true });
}

export function collectUnconfirmedLaunch(input) {
  return collectLaunchEvidence({ ...input, requireReady: false });
}

export function collectFailedAttempt(phaseEvents, build) {
  const evaluation = requireEvent(
    phaseEvents,
    "generationWillEvaluate",
    (event) =>
      value(event.bundleId) === build.bundleId &&
      value(event.releaseId) === build.releaseId &&
      event.primary === true,
    `primary candidate evaluation for ${build.variant}`,
  );
  return {
    ...eventIdentity(evaluation),
    event: "generationWillEvaluate",
  };
}

export function collectInvalidatedContexts(
  events,
  before,
  { reason = "reload", requireStaleAuthorities = true } = {},
) {
  const willRetireSequence = events.findIndex(
    (event) =>
      event.event === "generationWillRetire" &&
      value(event.processId) === before.identity.processId &&
      value(event.generationId) === before.identity.generationId &&
      event.reason === reason,
  );
  assert.ok(
    willRetireSequence >= 0,
    "Missing generationWillRetire for the old reload generation",
  );
  const retired = requireEvent(
    events,
    "generationRetired",
    (event) =>
      value(event.processId) === before.identity.processId &&
      value(event.generationId) === before.identity.generationId &&
      event.reason === reason,
    `completed ${reason} generation retirement`,
  );
  assert.ok(Array.isArray(retired.contextIds));
  const retiredSequence = eventSequence(events, retired);
  assert.ok(retiredSequence > willRetireSequence);
  assert.equal(
    retired.inFlightResourceCount,
    0,
    "generationRetired must prove that no resource request remains in flight",
  );
  const contextIds = retired.contextIds.map(String);
  const isOldContextEvent = (event) =>
    value(event.processId) === before.identity.processId &&
    value(event.generationId) === before.identity.generationId &&
    (event.contextId == null || contextIds.includes(value(event.contextId)));
  const oldAcquires = events
    .map((event, sequence) => ({ event, sequence }))
    .filter(
      ({ event, sequence }) =>
        sequence < retiredSequence &&
        event.event === "resourceLeaseAcquired" &&
        isOldContextEvent(event),
    );
  assert.ok(
    oldAcquires.every(({ sequence }) => sequence < willRetireSequence),
    "An old-generation resource lease was acquired after retirement started",
  );
  for (const { event: acquired, sequence } of oldAcquires) {
    const loadedSequence = events.findIndex(
      (event, index) =>
        index >= sequence &&
        index < willRetireSequence &&
        event.event === completionEvent(acquired.path) &&
        value(event.processId) === value(acquired.processId) &&
        value(event.generationId) === value(acquired.generationId) &&
        value(event.contextId) === value(acquired.contextId) &&
        value(event.path) === value(acquired.path) &&
        value(event.sha256) === value(acquired.sha256),
    );
    assert.ok(
      loadedSequence >= 0,
      "A resource lease lacks a matching successful consumer completion",
    );
  }
  assert.ok(
    !events
      .slice(willRetireSequence + 1, retiredSequence)
      .some(
        (event) =>
          ["resourceLoaded", "imageLoaded", "fontLoaded"].includes(
            event.event,
          ) && isOldContextEvent(event),
      ),
    "An old-generation resource loaded after retirement started",
  );
  const oldReleases = events
    .map((event, sequence) => ({ event, sequence }))
    .filter(
      ({ event, sequence }) =>
        sequence > willRetireSequence &&
        sequence < retiredSequence &&
        event.event === "resourceLeaseReleased" &&
        isOldContextEvent(event),
    );
  const leaseKey = ({ event }) =>
    [
      value(event.generationId),
      value(event.contextId),
      value(event.path),
      value(event.sha256),
    ].join("\u0000");
  const counts = (items) =>
    items.reduce((result, item) => {
      const key = leaseKey(item);
      result.set(key, (result.get(key) ?? 0) + 1);
      return result;
    }, new Map());
  const expectedLeases = new Map(
    contextIds.flatMap((contextId) =>
      before.resources.map((resource) => [
        [
          before.identity.generationId,
          contextId,
          resource.path,
          resource.sha256,
        ].join("\u0000"),
        1,
      ]),
    ),
  );
  assert.deepEqual(
    counts(oldAcquires),
    expectedLeases,
    "Every managed context must acquire each required resource exactly once",
  );
  assert.deepEqual(
    counts(oldReleases),
    counts(oldAcquires),
    "Every old-generation lease must have one matching release during retirement",
  );
  const eventsAfterRetirement = events.slice(retiredSequence + 1);
  const staleContextRejections = eventsAfterRetirement.filter(
    (event) =>
      event.event === "staleContextRejected" && isOldContextEvent(event),
  );
  assert.equal(
    staleContextRejections.length,
    requireStaleAuthorities ? contextIds.length : 0,
    requireStaleAuthorities
      ? "Every retired context must reject one retained diagnostic authority"
      : "Unexpected retained-authority probe for this retirement",
  );
  if (requireStaleAuthorities) {
    assert.deepEqual(
      staleContextRejections.map((event) => value(event.contextId)).sort(),
      [...contextIds].sort(),
      "Stale-context rejections must identify the exact retired context set",
    );
  }
  for (const rejection of staleContextRejections) {
    assert.equal(rejection.code, "STALE_CONTEXT");
    assert.ok(
      value(rejection.processId) === before.identity.processId &&
        value(rejection.generationId) === before.identity.generationId &&
        value(rejection.attemptId) === before.identity.attemptId &&
        value(rejection.bundleId) === before.identity.bundleId &&
        value(rejection.releaseId) === before.identity.releaseId,
      "Stale-context rejection lost its retired generation identity",
    );
  }
  const lateOldContextEvents = eventsAfterRetirement.filter(
    (event) =>
      event.event !== "staleContextRejected" && isOldContextEvent(event),
  );
  assert.equal(
    lateOldContextEvents.length,
    0,
    "An old-context event was emitted after generationRetired",
  );
  return {
    contextIds,
    leaseScope: "context",
    expectedLeaseCount: expectedLeases.size,
    inFlightResourceCount: 0,
    willRetireSequence,
    retiredSequence,
    allLeasesBalanced: true,
    staleContextRejections: staleContextRejections.map((event) => ({
      ...eventIdentity(event),
      code: event.code,
    })),
    oldContextsInvalidated:
      staleContextRejections.length === contextIds.length &&
      contextIds.length >= 2,
    lateOldContextEventCount: 0,
  };
}

export function normalizeBuild({
  role,
  compilerReceipt,
  deploymentReceipt,
  embeddedReceipt,
  runtimeId,
}) {
  const receipt = deploymentReceipt ?? embeddedReceipt;
  assert.ok(receipt, `Missing artifact receipt for ${role}`);
  const compiler = compilerReceipt.provenance?.framework;
  const compilerVersion = compilerReceipt.provenance?.rspeedy;
  assert.equal(typeof compiler, "string", `Missing compiler for ${role}`);
  assert.equal(
    typeof compilerVersion,
    "string",
    `Missing compiler version for ${role}`,
  );
  const files = {};
  for (const path of resourcePaths) {
    const built = compilerReceipt.files.find((file) => file.path === path);
    assert.ok(built, `Compiler output ${role} is missing ${path}`);
    files[path] = { sha256: built.sha256, byteSize: built.bytes };
  }
  return {
    variant: role,
    compiler,
    compilerVersion,
    runtimeId,
    bundleId: receipt.bundleId ?? receipt.embeddedBundleId,
    releaseId: deploymentReceipt?.releaseId ?? null,
    manifestSha256:
      receipt.persistedManifestFileHash ??
      receipt.manifestFileHash ??
      receipt.manifestFileHash,
    files,
  };
}

export function collectDeltaDelivery(deploymentReceipt, nativeLogs) {
  const changed =
    deploymentReceipt.deliveryArtifactResponse?.changedAssets?.[
      "main.lynx.bundle"
    ];
  const patch = changed?.patch;
  assert.equal(patch?.algorithm, "bsdiff");
  assert.equal(typeof patch.baseBundleId, "string");
  assert.match(patch.baseFileHash, /^[a-f0-9]{64}$/);
  assert.match(patch.patchFileHash, /^[a-f0-9]{64}$/);
  assert.match(changed.fileHash, /^[a-f0-9]{64}$/);
  const events = nativeLogs.split(/\r?\n/).flatMap((line) => {
    const marker = "HotUpdaterLynxEvent=";
    const at = line.indexOf(marker);
    if (at < 0) return [];
    const encoded = line.slice(at + marker.length).trim();
    try {
      return [JSON.parse(encoded)];
    } catch {
      throw new Error(`Malformed structured Lynx install event: ${encoded}`);
    }
  });
  const applied = events.filter(
    (event) =>
      event.event === "HotUpdaterBsdiffPatchApplied" &&
      event.bundleId === deploymentReceipt.bundleId &&
      event.releaseId === deploymentReceipt.releaseId &&
      event.baseBundleId === patch.baseBundleId &&
      event.asset === "main.lynx.bundle",
  );
  assert.equal(
    applied.length,
    1,
    "Expected one target-specific structured BSDIFF application event",
  );
  const application = applied[0];
  assert.equal(application.schemaVersion, 1);
  assert.equal(typeof application.transactionId, "string");
  assert.ok(application.transactionId.length > 0);
  assert.equal(application.patchFileHash, patch.patchFileHash);
  assert.equal(application.reconstructedFileHash, changed.fileHash);
  const applicationSequence = events.indexOf(application);
  const manifestSequence = events.findIndex(
    (event, index) =>
      index > applicationSequence &&
      event.event === "HotUpdaterManifestDiffApplied" &&
      event.transactionId === application.transactionId &&
      event.bundleId === deploymentReceipt.bundleId &&
      event.releaseId === deploymentReceipt.releaseId &&
      event.baseBundleId === patch.baseBundleId,
  );
  assert.ok(
    manifestSequence > applicationSequence,
    "Missing subsequent ManifestDiffApplied for the BSDIFF transaction",
  );
  assert.ok(
    !nativeLogs.includes(
      `HotUpdaterArchiveFallbackApplied bundleId=${deploymentReceipt.bundleId}`,
    ),
    "Native logs report archive fallback for the delta target",
  );
  return {
    transport: "bsdiff",
    algorithm: "bsdiff",
    transactionId: application.transactionId,
    baseBundleId: patch.baseBundleId,
    targetBundleId: deploymentReceipt.bundleId,
    archiveFallbackUsed: false,
    patchSha256: application.patchFileHash,
    baseSha256: patch.baseFileHash,
    targetSha256: changed.fileHash,
    reconstructedSha256: application.reconstructedFileHash,
  };
}
