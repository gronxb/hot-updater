import assert from "node:assert/strict";

import { SPARKLING_NAVIGATION_PROVENANCE } from "@hot-updater/lynx/navigationProvenance";

export const resourcePaths = [
  "main.lynx.bundle",
  "detail.lynx.bundle",
  "assets/probe.png",
  "assets/probe.ttf",
  "assets/bootstrap.js",
  "dynamic/component.lynx.bundle",
];

export const pageResourcePaths = {
  "main.lynx.bundle": resourcePaths
    .filter((path) => path !== "detail.lynx.bundle")
    .sort(),
  "detail.lynx.bundle": ["detail.lynx.bundle"],
};
export const pageEntries = ["detail.lynx.bundle", "main.lynx.bundle"];
export const pageEssentialResources = pageEntries.map((entry) => ({
  entry,
  resources: pageResourcePaths[entry],
}));

const completionEvent = (path) => {
  if (path === "assets/probe.png") return "imageLoaded";
  if (path === "assets/probe.ttf") return "fontLoaded";
  return "resourceLoaded";
};

const value = (input) => {
  if (input === null || input === undefined) return null;
  assert.equal(
    typeof input,
    "string",
    "Managed identity values must be strings",
  );
  assert.ok(input.length > 0, "Managed identity strings must be nonempty");
  return input;
};

function sameIdentity(event, identity) {
  return (
    value(event.runtimeId) === identity.runtimeId &&
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
    value(event.runtimeId) === identity.runtimeId &&
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

function validateEventIdentityFields(event) {
  for (const key of [
    "runtimeId",
    "processId",
    "generationId",
    "bundleId",
    "releaseId",
    "contextId",
    "pageAttemptId",
    "transitionId",
  ]) {
    assert.ok(
      Object.hasOwn(event, key),
      `Matrix event is missing ${key}: ${JSON.stringify(event)}`,
    );
  }
  assert.ok(value(event.runtimeId), "Matrix event is missing runtimeId");
  assert.match(
    value(event.processId),
    /^[1-9][0-9]*$/,
    "Matrix event processId must be a canonical positive decimal string",
  );
  assert.ok(value(event.generationId), "Matrix event is missing generationId");
  assert.ok(value(event.bundleId), "Matrix event is missing bundleId");
  value(event.releaseId);
  value(event.contextId);
  value(event.pageAttemptId);
  value(event.transitionId);
}

export function eventIdentity(event) {
  validateEventIdentityFields(event);
  const identity = {
    runtimeId: value(event.runtimeId),
    processId: value(event.processId),
    generationId: value(event.generationId),
    contextId: value(event.contextId),
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

function hasCompleteLaunchEvents(
  events,
  build,
  processId,
  requireReady,
  requireDetailReady = true,
) {
  const started = events.find(
    (event) =>
      event.event === "generationStarted" &&
      value(event.processId) === String(processId) &&
      value(event.bundleId) === build.bundleId &&
      value(event.releaseId) === build.releaseId &&
      Array.isArray(event.contextIds) &&
      event.contextIds.length === 1 &&
      event.topPageEntry === "main.lynx.bundle",
  );
  if (!started) return false;
  let identity;
  try {
    identity = eventIdentity(started);
  } catch {
    return false;
  }
  const opened = events.find(
    (event) =>
      ["pageOpened", "routeOpened"].includes(event.event) &&
      event.pageEntry === "detail.lynx.bundle" &&
      value(event.sourceContextId) === identity.contextId &&
      sameGenerationSelection(event, identity) &&
      value(event.contextId) !== identity.contextId &&
      event.topPageEntry === "detail.lynx.bundle" &&
      JSON.stringify(event.orderedPageEntries) ===
        JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]),
  );
  if (!opened) return false;
  const detailIdentity = eventIdentity(opened);
  const pageAttemptId = value(opened.pageAttemptId);
  const complete = (memberIdentity, pageEntry, readyEvent, expectReady) =>
    events.some(
      (event) =>
        event.event === "firstContent" && sameIdentity(event, memberIdentity),
    ) &&
    events.some(
      (event) =>
        event.event === readyEvent && sameIdentity(event, memberIdentity),
    ) === expectReady &&
    pageResourcePaths[pageEntry].every((path) =>
      events.some(
        (event) =>
          event.event === completionEvent(path) &&
          event.path === path &&
          sameIdentity(event, memberIdentity),
      ),
    );
  const admittedTerminal = events.some(
    (event) =>
      event.event === "pageAttemptTerminal" &&
      event.terminal === "admitted" &&
      value(event.pageAttemptId) === pageAttemptId &&
      sameIdentity(event, detailIdentity),
  );
  return (
    pageAttemptId !== null &&
    complete(identity, "main.lynx.bundle", "jsReady", requireReady) &&
    complete(
      detailIdentity,
      "detail.lynx.bundle",
      "pageAdmitted",
      requireDetailReady,
    ) &&
    admittedTerminal === requireDetailReady
  );
}

export function hasCompleteReadyEvents(events, build, processId) {
  return hasCompleteLaunchEvents(events, build, processId, true);
}

export function hasCompleteAlreadyRunningDetailEvents(
  events,
  build,
  processId,
) {
  const opened = events.find(
    (event) =>
      ["pageOpened", "routeOpened"].includes(event.event) &&
      value(event.processId) === String(processId) &&
      value(event.bundleId) === build.bundleId &&
      value(event.releaseId) === build.releaseId &&
      event.pageEntry === "detail.lynx.bundle" &&
      value(event.contextId) !== value(event.sourceContextId) &&
      value(event.pageAttemptId) !== null &&
      event.topPageEntry === "detail.lynx.bundle" &&
      JSON.stringify(event.orderedPageEntries) ===
        JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]),
  );
  if (!opened) return false;
  let detailIdentity;
  try {
    detailIdentity = eventIdentity(opened);
  } catch {
    return false;
  }
  const pageAttemptId = value(opened.pageAttemptId);
  return (
    events.some(
      (event) =>
        event.event === "firstContent" && sameIdentity(event, detailIdentity),
    ) &&
    pageResourcePaths["detail.lynx.bundle"].every((resourcePath) =>
      events.some(
        (event) =>
          event.event === completionEvent(resourcePath) &&
          event.path === resourcePath &&
          sameIdentity(event, detailIdentity),
      ),
    ) &&
    events.some(
      (event) =>
        event.event === "pageAdmitted" &&
        value(event.pageAttemptId) === pageAttemptId &&
        sameIdentity(event, detailIdentity),
    ) &&
    events.some(
      (event) =>
        event.event === "pageAttemptTerminal" &&
        event.terminal === "admitted" &&
        value(event.pageAttemptId) === pageAttemptId &&
        sameIdentity(event, detailIdentity),
    )
  );
}

export function hasCompleteUnconfirmedEvents(events, build, processId) {
  return hasCompleteLaunchEvents(events, build, processId, false);
}

export function hasCompletePendingDetailEvents(
  events,
  build,
  processId,
  primaryReady,
) {
  return hasCompleteLaunchEvents(events, build, processId, primaryReady, false);
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
  const terminalStates = new Set([
    "admitted",
    "verified-fatal",
    "authorized-cancel",
    "process-interruption",
  ]);
  for (const event of events) {
    validateEventIdentityFields(event);
    if (event.event === "pageAttemptTerminal") {
      assert.ok(
        terminalStates.has(event.terminal),
        `Invalid page-attempt terminal state: ${String(event.terminal)}`,
      );
    }
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
  const terminal = requireEvent(
    events,
    "pageAttemptTerminal",
    (event) =>
      event.terminal === "verified-fatal" &&
      value(event.pageAttemptId) === value(runtimeFailed.pageAttemptId) &&
      sameIdentity(event, failureIdentity),
    "durable fatal page-attempt terminal",
  );
  assert.equal(
    events.filter(
      (event) =>
        event.event === "pageAttemptTerminal" &&
        value(event.pageAttemptId) === value(runtimeFailed.pageAttemptId) &&
        sameIdentity(event, failureIdentity),
    ).length,
    1,
    "Fatal page attempt must have exactly one durable terminal",
  );
  const runtimeFailedSequence = eventSequence(events, runtimeFailed);
  const pageAttemptTerminalSequence = eventSequence(events, terminal);
  const generationFailedSequence = eventSequence(events, recorded);
  assert.ok(
    runtimeFailedSequence < pageAttemptTerminalSequence &&
      pageAttemptTerminalSequence < generationFailedSequence,
    "runtimeFailed, durable fatal terminal, and generationFailed are out of order",
  );
  return {
    ...failureIdentity,
    event: "runtimeFailed",
    runtimeFailedSequence,
    pageAttemptTerminalSequence,
    generationFailedSequence,
    pageAttemptTerminal: {
      ...eventIdentity(terminal),
      pageAttemptId: value(terminal.pageAttemptId),
      terminal: terminal.terminal,
    },
  };
}

function collectLaunchEvidence({
  phaseEvents,
  allEvents,
  build,
  processId,
  requireReady,
  requireDetailReady = true,
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
    "generationStarted must declare its initial context membership",
  );
  const initialContextIds = started.contextIds.map(String);
  assert.ok(
    (initialContextIds.length === 1 || initialContextIds.length === 2) &&
      initialContextIds[0] === identity.contextId,
    "generationStarted must contain the ordered managed page contexts",
  );
  const reconstructedStack = initialContextIds.length === 2;
  assert.deepEqual(
    started.orderedPageEntries,
    reconstructedStack
      ? ["main.lynx.bundle", "detail.lynx.bundle"]
      : ["main.lynx.bundle"],
    "generationStarted page order does not match its managed contexts",
  );
  if (reconstructedStack) {
    assert.ok(
      JSON.stringify(started.orderedPageParameters) ===
        JSON.stringify([[], [{ name: "title", value: "Second Page" }]]) ||
        JSON.stringify(started.orderedPageParameters) ===
          JSON.stringify([{}, { title: "Second Page" }]),
      "Reconstructed detail parameters changed",
    );
    assert.equal(started.topPageEntry, "detail.lynx.bundle");
  }
  const opened = requireEvent(
    phaseEvents,
    phaseEvents.some((event) => event.event === "pageOpened")
      ? "pageOpened"
      : "routeOpened",
    (event) =>
      event.pageEntry === "detail.lynx.bundle" &&
      value(event.sourceContextId) === identity.contextId &&
      sameGenerationSelection(event, identity) &&
      value(event.contextId) !== identity.contextId,
    `real detail navigation for ${build.variant}`,
  );
  assert.deepEqual(opened.orderedPageEntries, [
    "main.lynx.bundle",
    "detail.lynx.bundle",
  ]);
  assert.equal(opened.topPageEntry, "detail.lynx.bundle");
  assert.equal(opened.outcome, "opened");
  assert.deepEqual(opened.parameters ?? opened.pageParameters, {
    title: "Second Page",
  });
  assert.match(
    String(opened.nativePageClass),
    /SPKViewController|HotUpdaterSparklingPageActivity$/,
  );
  const detailIdentity = eventIdentity(opened);
  const pageAttemptId = value(opened.pageAttemptId);
  assert.ok(pageAttemptId, "Detail navigation is missing pageAttemptId");
  const contextIds = [identity.contextId, detailIdentity.contextId];
  if (reconstructedStack) assert.deepEqual(initialContextIds, contextIds);
  assert.deepEqual(
    opened.orderedPageEntries,
    ["main.lynx.bundle", "detail.lynx.bundle"],
    "Detail navigation must push the real native page stack",
  );
  const members = [
    { memberIdentity: identity, pageEntry: "main.lynx.bundle", primary: true },
    {
      memberIdentity: detailIdentity,
      pageEntry: "detail.lynx.bundle",
      primary: false,
    },
  ].map(({ memberIdentity, pageEntry, primary }) => {
    const evaluation = primary
      ? requireEvent(
          phaseEvents,
          "generationWillEvaluate",
          (event) =>
            sameIdentity(event, memberIdentity) && event.primary === true,
          `generationWillEvaluate for ${build.variant} main`,
        )
      : opened;
    const firstContentEvent = requireEvent(
      phaseEvents,
      "firstContent",
      (event) => sameIdentity(event, memberIdentity),
      `firstContent for ${build.variant} ${pageEntry}`,
    );
    const readyEvent = phaseEvents.find(
      (event) =>
        event.event === (primary ? "jsReady" : "pageAdmitted") &&
        sameIdentity(event, memberIdentity),
    );
    const pageAttemptTerminal =
      primary || !requireDetailReady
        ? null
        : requireEvent(
            phaseEvents,
            "pageAttemptTerminal",
            (event) =>
              event.terminal === "admitted" &&
              value(event.pageAttemptId) === pageAttemptId &&
              sameIdentity(event, memberIdentity),
            `durable page admission terminal for ${build.variant} ${pageEntry}`,
          );
    if (pageAttemptTerminal) {
      assert.equal(
        phaseEvents.filter(
          (event) =>
            event.event === "pageAttemptTerminal" &&
            value(event.pageAttemptId) === pageAttemptId &&
            sameIdentity(event, memberIdentity),
        ).length,
        1,
        `Page attempt ${pageAttemptId} must have exactly one durable terminal`,
      );
    }
    const memberRequiresReady = primary ? requireReady : requireDetailReady;
    if (memberRequiresReady) {
      assert.ok(
        readyEvent,
        `Missing ${primary ? "jsReady" : "pageAdmitted"} for ${build.variant} ${pageEntry}`,
      );
    } else {
      assert.equal(
        readyEvent,
        undefined,
        `Pending ${pageEntry} unexpectedly emitted readiness`,
      );
      if (!primary) {
        assert.equal(
          phaseEvents.find(
            (event) =>
              event.event === "pageAttemptTerminal" &&
              value(event.pageAttemptId) === pageAttemptId,
          ),
          undefined,
          `Pending ${pageEntry} unexpectedly emitted a terminal state`,
        );
      }
    }
    if (pageAttemptTerminal && readyEvent) {
      const terminalSequence = eventSequence(allEvents, pageAttemptTerminal);
      const readySequence = eventSequence(allEvents, readyEvent);
      assert.ok(
        opened.event === "pageOpened"
          ? terminalSequence < readySequence
          : readySequence < terminalSequence,
        "Durable admission and pageAdmitted callbacks are out of platform order",
      );
    }
    const resources = pageResourcePaths[pageEntry].map((path) => {
      const loaded = phaseEvents.find(
        (event) =>
          event.event === completionEvent(path) &&
          event.path === path &&
          sameIdentity(event, memberIdentity),
      );
      assert.ok(
        loaded,
        `Missing successful resource completion for ${build.variant} ${pageEntry} ${path}`,
      );
      const acquired = requireEvent(
        allEvents,
        "resourceLeaseAcquired",
        (event) =>
          event.path === path &&
          value(event.sha256) === value(loaded.sha256) &&
          sameIdentity(event, memberIdentity),
        `resourceLeaseAcquired for ${build.variant} ${pageEntry} ${path}`,
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
      pageEntry,
      primary,
      readinessAuthority: primary,
      evaluationSequence: eventSequence(allEvents, evaluation),
      firstContentSequence: eventSequence(allEvents, firstContentEvent),
      jsReadySequence: readyEvent ? eventSequence(allEvents, readyEvent) : null,
      firstContent: eventIdentity(firstContentEvent),
      jsReady: primary && readyEvent ? eventIdentity(readyEvent) : null,
      pageAdmitted: !primary && readyEvent ? eventIdentity(readyEvent) : null,
      pageAttemptTerminal: pageAttemptTerminal
        ? {
            ...eventIdentity(pageAttemptTerminal),
            pageAttemptId: value(pageAttemptTerminal.pageAttemptId),
            terminal: pageAttemptTerminal.terminal,
          }
        : null,
      confirmation: readyEvent?.confirmation ?? null,
      nativePageClass: primary ? null : String(opened.nativePageClass),
      sourceContextId: primary ? null : value(opened.sourceContextId),
      parameters: primary ? {} : (opened.parameters ?? opened.pageParameters),
      pageAttemptId: primary ? null : pageAttemptId,
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
    detailReadinessWithheld: !requireDetailReady,
    reconstructedStack,
  };
}

export function collectReadyLaunch(input) {
  return collectLaunchEvidence({ ...input, requireReady: true });
}

export function collectUnconfirmedLaunch(input) {
  return collectLaunchEvidence({ ...input, requireReady: false });
}

export function collectPendingDetailLaunch(input) {
  return collectLaunchEvidence({
    ...input,
    requireReady: input.primaryReady,
    requireDetailReady: false,
  });
}

export function collectFatalPendingDetailLaunch({
  phaseEvents,
  allEvents,
  build,
  processId,
  primaryReady,
  existingLaunch = null,
}) {
  const started = existingLaunch
    ? null
    : requireEvent(
        phaseEvents,
        "generationStarted",
        (event) =>
          value(event.processId) === String(processId) &&
          value(event.bundleId) === build.bundleId &&
          value(event.releaseId) === build.releaseId,
        `generationStarted for ${build.variant}`,
      );
  const primaryIdentity = existingLaunch?.identity ?? eventIdentity(started);
  const opened = requireEvent(
    phaseEvents,
    phaseEvents.some((event) => event.event === "pageOpened")
      ? "pageOpened"
      : "routeOpened",
    (event) =>
      event.pageEntry === "detail.lynx.bundle" &&
      value(event.sourceContextId) === primaryIdentity.contextId &&
      sameGenerationSelection(event, primaryIdentity) &&
      value(event.contextId) !== primaryIdentity.contextId,
    `pending fatal detail navigation for ${build.variant}`,
  );
  assert.deepEqual(opened.orderedPageEntries, [
    "main.lynx.bundle",
    "detail.lynx.bundle",
  ]);
  assert.equal(opened.topPageEntry, "detail.lynx.bundle");
  assert.equal(opened.outcome, "opened");
  assert.deepEqual(opened.parameters ?? opened.pageParameters, {
    title: "Second Page",
  });
  assert.match(
    String(opened.nativePageClass),
    /SPKViewController|HotUpdaterSparklingPageActivity$/,
  );
  const detailIdentity = eventIdentity(opened);
  const pageAttemptId = value(opened.pageAttemptId);
  assert.ok(
    pageAttemptId,
    "Pending detail navigation is missing pageAttemptId",
  );
  const runtimeFailed = requireEvent(
    phaseEvents,
    "runtimeFailed",
    (event) =>
      sameIdentity(event, detailIdentity) &&
      value(event.pageAttemptId) === pageAttemptId,
    `pending fatal detail failure for ${build.variant}`,
  );
  const openedSequence = eventSequence(allEvents, opened);
  const failedSequence = eventSequence(allEvents, runtimeFailed);
  assert.ok(
    openedSequence < failedSequence,
    "Detail must open before it fails",
  );
  assert.equal(
    allEvents
      .slice(openedSequence + 1, failedSequence)
      .some(
        (event) =>
          event.event === "pageAdmitted" && sameIdentity(event, detailIdentity),
      ),
    false,
    "Fatal pending detail was admitted before failure",
  );

  const primaryMember = existingLaunch?.members.find(
    (member) => member.primary,
  );
  let resolvedPrimaryMember = primaryMember;
  if (!resolvedPrimaryMember) {
    const evaluation = requireEvent(
      phaseEvents,
      "generationWillEvaluate",
      (event) => sameIdentity(event, primaryIdentity) && event.primary === true,
      `generationWillEvaluate for ${build.variant} main`,
    );
    const firstContent = requireEvent(
      phaseEvents,
      "firstContent",
      (event) => sameIdentity(event, primaryIdentity),
      `firstContent for ${build.variant} main`,
    );
    const ready = phaseEvents.find(
      (event) =>
        event.event === "jsReady" && sameIdentity(event, primaryIdentity),
    );
    assert.equal(
      Boolean(ready),
      primaryReady,
      "Primary readiness timing is wrong",
    );
    const resources = pageResourcePaths["main.lynx.bundle"].map((path) => {
      const loaded = requireEvent(
        phaseEvents,
        completionEvent(path),
        (event) => event.path === path && sameIdentity(event, primaryIdentity),
        `${completionEvent(path)} for ${build.variant} main ${path}`,
      );
      const acquired = requireEvent(
        allEvents,
        "resourceLeaseAcquired",
        (event) =>
          event.path === path &&
          value(event.sha256) === value(loaded.sha256) &&
          sameIdentity(event, primaryIdentity),
        `resourceLeaseAcquired for ${build.variant} main ${path}`,
      );
      const acquiredSequence = eventSequence(allEvents, acquired);
      const releasedSequence = allEvents.findIndex(
        (event, index) =>
          index > acquiredSequence &&
          event.event === "resourceLeaseReleased" &&
          event.path === path &&
          value(event.sha256) === value(loaded.sha256) &&
          sameIdentity(event, primaryIdentity),
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
    resolvedPrimaryMember = {
      identity: primaryIdentity,
      pageEntry: "main.lynx.bundle",
      primary: true,
      readinessAuthority: true,
      evaluationSequence: eventSequence(allEvents, evaluation),
      firstContentSequence: eventSequence(allEvents, firstContent),
      jsReadySequence: ready ? eventSequence(allEvents, ready) : null,
      firstContent: eventIdentity(firstContent),
      jsReady: ready ? eventIdentity(ready) : null,
      pageAdmitted: null,
      pageAttemptTerminal: null,
      confirmation: ready?.confirmation ?? null,
      nativePageClass: null,
      sourceContextId: null,
      parameters: {},
      resources,
    };
  }
  assert.ok(resolvedPrimaryMember);
  const detailFirstContent = requireEvent(
    phaseEvents,
    "firstContent",
    (event) => sameIdentity(event, detailIdentity),
    `firstContent for pending fatal ${build.variant} detail`,
  );
  const detailResources = pageResourcePaths["detail.lynx.bundle"].map(
    (path) => {
      const loaded = requireEvent(
        phaseEvents,
        completionEvent(path),
        (event) => event.path === path && sameIdentity(event, detailIdentity),
        `${completionEvent(path)} for pending fatal ${build.variant} detail`,
      );
      const acquired = requireEvent(
        allEvents,
        "resourceLeaseAcquired",
        (event) =>
          event.path === path &&
          value(event.sha256) === value(loaded.sha256) &&
          sameIdentity(event, detailIdentity),
        `resourceLeaseAcquired for pending fatal ${build.variant} detail`,
      );
      const acquiredSequence = eventSequence(allEvents, acquired);
      const releasedSequence = allEvents.findIndex(
        (event, index) =>
          index > acquiredSequence &&
          event.event === "resourceLeaseReleased" &&
          event.path === path &&
          value(event.sha256) === value(loaded.sha256) &&
          sameIdentity(event, detailIdentity),
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
    },
  );
  const detailFirstContentSequence = eventSequence(
    allEvents,
    detailFirstContent,
  );
  assert.ok(
    detailResources.every(
      (resource) => resource.loadedSequence < detailFirstContentSequence,
    ) && detailFirstContentSequence < failedSequence,
    "Detail resources and first content must precede the fatal classification",
  );
  const detailMember = {
    identity: detailIdentity,
    pageEntry: "detail.lynx.bundle",
    primary: false,
    readinessAuthority: false,
    evaluationSequence: openedSequence,
    firstContentSequence: detailFirstContentSequence,
    jsReadySequence: null,
    firstContent: eventIdentity(detailFirstContent),
    jsReady: null,
    pageAdmitted: null,
    pageAttemptTerminal: null,
    confirmation: null,
    nativePageClass: String(opened.nativePageClass),
    sourceContextId: value(opened.sourceContextId),
    parameters: opened.parameters ?? opened.pageParameters,
    resources: detailResources,
    pageAttemptId,
  };
  return {
    identity: primaryIdentity,
    contextIds: [primaryIdentity.contextId, detailIdentity.contextId],
    evaluationSequence: resolvedPrimaryMember.evaluationSequence,
    firstContentSequence: resolvedPrimaryMember.firstContentSequence,
    jsReadySequence: resolvedPrimaryMember.jsReadySequence,
    firstContent: resolvedPrimaryMember.firstContent,
    jsReady: resolvedPrimaryMember.jsReady,
    confirmation: resolvedPrimaryMember.confirmation,
    resources: resolvedPrimaryMember.resources,
    members: [resolvedPrimaryMember, detailMember],
    readinessWithheld: !primaryReady,
    detailReadinessWithheld: true,
    detailFailedBeforeAdmission: true,
  };
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

export function collectProcessInterruption(events, candidateLaunch) {
  const detail = candidateLaunch.members.find((member) => !member.primary);
  assert.ok(detail, "Pending interruption evidence is missing its detail page");
  const terminal = requireEvent(
    events,
    "pageAttemptTerminal",
    (event) =>
      event.terminal === "process-interruption" &&
      value(event.pageAttemptId) === value(detail.pageAttemptId) &&
      sameIdentity(event, detail.identity),
    "durable process-interruption page-attempt terminal",
  );
  assert.equal(
    events.filter(
      (event) =>
        event.event === "pageAttemptTerminal" &&
        value(event.pageAttemptId) === value(detail.pageAttemptId) &&
        sameIdentity(event, detail.identity),
    ).length,
    1,
    "Interrupted page attempt must have exactly one durable terminal",
  );
  assert.equal(
    events.some(
      (event) =>
        ["runtimeFailed", "generationFailed"].includes(event.event) &&
        sameIdentity(event, detail.identity),
    ),
    false,
    "Process interruption was incorrectly classified as a verified fatal failure",
  );
  return {
    ...eventIdentity(terminal),
    event: "pageAttemptTerminal",
    pageAttemptId: value(terminal.pageAttemptId),
    terminal: terminal.terminal,
    terminalSequence: eventSequence(events, terminal),
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
    before.members.flatMap((member) =>
      member.resources.map((resource) => [
        [
          before.identity.generationId,
          member.identity.contextId,
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
  assert.deepEqual(
    compilerReceipt.pageEntries,
    pageEntries,
    `Compiler output ${role} has an invalid page entry set`,
  );
  assert.deepEqual(
    compilerReceipt.pageEssentialResources,
    pageEssentialResources,
    `Compiler output ${role} has an invalid page resource graph`,
  );
  assert.deepEqual(
    compilerReceipt.provenance?.sparklingNavigation,
    SPARKLING_NAVIGATION_PROVENANCE,
    `Compiler output ${role} has invalid Sparkling navigation provenance`,
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
    source: receipt.source,
    provenance: compilerReceipt.provenance,
    runtimeId,
    bundleId: receipt.bundleId ?? receipt.embeddedBundleId,
    releaseId: deploymentReceipt?.releaseId ?? null,
    pageEntries,
    pageEssentialResources,
    sparklingNavigation: SPARKLING_NAVIGATION_PROVENANCE,
    manifestSha256:
      receipt.persistedManifestFileHash ??
      receipt.manifestFileHash ??
      receipt.manifestFileHash,
    files,
  };
}

export function collectDeltaDelivery(deploymentReceipt, nativeLogs) {
  assert.match(
    deploymentReceipt.deliveryArtifactResponse?.fileUrl,
    /^https?:\/\//,
  );
  assert.match(
    deploymentReceipt.deliveryArtifactResponse?.fileHash,
    /^[a-f0-9]{64}$/,
  );
  const changed =
    deploymentReceipt.deliveryArtifactResponse?.changedAssets?.[
      "main.lynx.bundle"
    ];
  const patch = changed?.patch;
  const rawDetail =
    deploymentReceipt.deliveryArtifactResponse?.changedAssets?.[
      "detail.lynx.bundle"
    ];
  const manifestUrl = deploymentReceipt.deliveryArtifactResponse?.manifestUrl;
  const manifestSha256 =
    deploymentReceipt.deliveryArtifactResponse?.manifestFileHash;
  assert.ok(deploymentReceipt.deliveryArtifactUrl);
  assert.ok(manifestUrl);
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(changed?.file?.url);
  assert.ok(patch?.patchUrl);
  assert.equal(patch?.algorithm, "bsdiff");
  assert.equal(typeof patch.baseBundleId, "string");
  assert.match(patch.baseFileHash, /^[a-f0-9]{64}$/);
  assert.match(patch.patchFileHash, /^[a-f0-9]{64}$/);
  assert.match(changed.fileHash, /^[a-f0-9]{64}$/);
  assert.ok(rawDetail?.file?.url);
  assert.match(rawDetail.fileHash, /^[a-f0-9]{64}$/);
  assert.equal(rawDetail.patch, undefined);
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
  const completed = applied.filter((candidate) => {
    const candidateSequence = events.indexOf(candidate);
    return events.some(
      (event, index) =>
        index > candidateSequence &&
        event.event === "HotUpdaterManifestDiffApplied" &&
        event.transactionId === candidate.transactionId &&
        event.bundleId === deploymentReceipt.bundleId &&
        event.releaseId === deploymentReceipt.releaseId &&
        event.baseBundleId === patch.baseBundleId,
    );
  });
  assert.equal(
    completed.length,
    1,
    "Expected one committed target-specific BSDIFF transaction",
  );
  const application = completed[0];
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
    archiveFileHash: deploymentReceipt.deliveryArtifactResponse.fileHash,
    archiveFileUrl: deploymentReceipt.deliveryArtifactResponse.fileUrl,
    deliveryArtifactUrl: deploymentReceipt.deliveryArtifactUrl,
    manifestUrl,
    manifestSha256,
    mainAssetPath: "main.lynx.bundle",
    mainFileUrl: changed.file.url,
    patchUrl: patch.patchUrl,
    patchSha256: application.patchFileHash,
    baseSha256: patch.baseFileHash,
    targetSha256: changed.fileHash,
    reconstructedSha256: application.reconstructedFileHash,
    rawDetailAssetPath: "detail.lynx.bundle",
    rawDetailFileUrl: rawDetail.file.url,
    rawDetailSha256: rawDetail.fileHash,
  };
}
