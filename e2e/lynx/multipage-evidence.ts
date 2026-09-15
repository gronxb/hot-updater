import type {
  GenerationEvent,
  GenerationEventsSnapshot,
} from "../../examples/lynx/src/e2eApp/generationEvents.ts";
import { compareGenerationEventSequence } from "../../examples/lynx/src/e2eApp/generationEvents.ts";

export type ManagedSelection = {
  readonly bundleId: string;
  readonly releaseId: string | null;
};

export type ManagedPageIdentity = ManagedSelection & {
  readonly runtimeId: string;
  readonly processId: string;
  readonly generationId: string;
  readonly contextId: string;
  readonly attemptId: string;
};

export type ManagedPendingPageIdentity = ManagedPageIdentity & {
  readonly pageAttemptId: string;
};

const record = (
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const nullableString = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  return string(value, label);
};

const strings = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
};

const identity = (event: GenerationEvent): ManagedPageIdentity => {
  const processId = string(event.details.processId, `${event.name}.processId`);
  if (!/^[1-9][0-9]*$/.test(processId)) {
    throw new Error(
      `${event.name}.processId must be a canonical positive decimal string`,
    );
  }
  return {
    runtimeId: string(event.details.runtimeId, `${event.name}.runtimeId`),
    processId,
    generationId: string(
      event.details.generationId,
      `${event.name}.generationId`,
    ),
    contextId: string(event.details.contextId, `${event.name}.contextId`),
    attemptId: string(event.details.attemptId, `${event.name}.attemptId`),
    bundleId: string(event.details.bundleId, `${event.name}.bundleId`),
    releaseId: nullableString(
      event.details.releaseId,
      `${event.name}.releaseId`,
    ),
  };
};

const sameSelection = (left: ManagedPageIdentity, right: ManagedPageIdentity) =>
  left.runtimeId === right.runtimeId &&
  left.processId === right.processId &&
  left.generationId === right.generationId &&
  left.attemptId === right.attemptId &&
  left.bundleId === right.bundleId &&
  left.releaseId === right.releaseId;

const requireEvent = (
  snapshot: GenerationEventsSnapshot,
  names: readonly string[],
  predicate: (event: GenerationEvent) => boolean,
  label: string,
) => {
  const found = snapshot.events.findLast(
    (event) => names.includes(event.name) && predicate(event),
  );
  if (!found) throw new Error(`Missing authentic native ${label} event`);
  return found;
};

const assertSelection = (
  observed: ManagedPageIdentity,
  expected: ManagedSelection,
  label: string,
) => {
  if (
    observed.bundleId !== expected.bundleId ||
    observed.releaseId !== expected.releaseId
  ) {
    throw new Error(`${label} does not match the expected Release`);
  }
};

const assertNativePageClass = (
  event: GenerationEvent,
  platform: "ios" | "android",
) => {
  const pageClass = string(
    event.details.nativePageClass,
    `${event.name}.nativePageClass`,
  );
  if (
    (platform === "ios" && !pageClass.includes("SPKViewController")) ||
    (platform === "android" &&
      !pageClass.endsWith("HotUpdaterSparklingPageActivity"))
  ) {
    throw new Error(`Unexpected ${platform} managed page class: ${pageClass}`);
  }
};

export function assertManagedMainPage(
  snapshot: GenerationEventsSnapshot,
  expected: ManagedSelection,
): ManagedPageIdentity {
  const started = requireEvent(
    snapshot,
    ["generationStarted"],
    (event) =>
      JSON.stringify(event.details.orderedPageEntries) ===
        JSON.stringify(["main.lynx.bundle"]) &&
      event.details.topPageEntry === "main.lynx.bundle" &&
      event.details.bundleId === expected.bundleId &&
      event.details.releaseId === expected.releaseId,
    "main generationStarted",
  );
  const main = identity(started);
  assertSelection(main, expected, "Main generation");
  const contextIds = strings(started.details.contextIds, "contextIds");
  if (contextIds.length !== 1 || contextIds[0] !== main.contextId) {
    throw new Error("The initial generation must contain one real main page");
  }
  requireEvent(
    snapshot,
    ["firstContent"],
    (event) => {
      const observed = identity(event);
      return (
        observed.contextId === main.contextId && sameSelection(observed, main)
      );
    },
    "main firstContent",
  );
  requireEvent(
    snapshot,
    ["jsReady"],
    (event) => {
      const observed = identity(event);
      return (
        observed.contextId === main.contextId && sameSelection(observed, main)
      );
    },
    "main jsReady",
  );
  return main;
}

export function assertManagedDetailOpened(
  snapshot: GenerationEventsSnapshot,
  options: {
    readonly platform: "ios" | "android";
    readonly main: ManagedPageIdentity;
    readonly detailSha256?: string;
    readonly expectedParameters?: Readonly<Record<string, string>>;
  },
): ManagedPageIdentity {
  const opened = requireEvent(
    snapshot,
    options.platform === "ios" ? ["pageOpened"] : ["routeOpened"],
    (event) =>
      event.details.pageEntry === "detail.lynx.bundle" &&
      event.details.sourceContextId === options.main.contextId &&
      event.details.outcome === "opened",
    "detail open",
  );
  assertNativePageClass(opened, options.platform);
  const detail = identity(opened);
  if (
    !sameSelection(detail, options.main) ||
    detail.contextId === options.main.contextId
  ) {
    throw new Error(
      "Detail must use a distinct context in the running Release",
    );
  }
  if (
    JSON.stringify(opened.details.orderedPageEntries) !==
      JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]) ||
    opened.details.topPageEntry !== "detail.lynx.bundle"
  ) {
    throw new Error("Detail open did not push the expected native page stack");
  }
  const params = record(
    opened.details.parameters ?? opened.details.pageParameters,
    "detail params",
  );
  const expectedParameters = options.expectedParameters ?? {
    title: "Second Page",
  };
  const parameterKeys = Object.keys(params);
  const expectedParameterKeys = Object.keys(expectedParameters);
  if (
    parameterKeys.length !== expectedParameterKeys.length ||
    expectedParameterKeys.some((key) => params[key] !== expectedParameters[key])
  ) {
    throw new Error("Detail navigation params were not forwarded exactly");
  }
  const firstContent = requireEvent(
    snapshot,
    ["firstContent"],
    (event) => identity(event).contextId === detail.contextId,
    "detail firstContent",
  );
  const admitted = requireEvent(
    snapshot,
    ["pageAdmitted"],
    (event) => identity(event).contextId === detail.contextId,
    "detail admission",
  );
  const pageAttemptId = string(
    admitted.details.pageAttemptId,
    "pageAdmitted.pageAttemptId",
  );
  const terminal = requireEvent(
    snapshot,
    ["pageAttemptTerminal"],
    (event) =>
      event.details.terminal === "admitted" &&
      event.details.pageAttemptId === pageAttemptId &&
      event.details.pageEntry === "detail.lynx.bundle" &&
      event.details.sourceContextId === options.main.contextId &&
      JSON.stringify(event.details.orderedPageEntries) ===
        JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]) &&
      event.details.topPageEntry === "detail.lynx.bundle",
    "durable detail admission terminal",
  );
  assertNativePageClass(terminal, options.platform);
  if (
    !sameSelection(identity(firstContent), detail) ||
    !sameSelection(identity(admitted), detail) ||
    !sameSelection(identity(terminal), detail)
  ) {
    throw new Error("Detail readiness came from another managed Release");
  }
  const resource = requireEvent(
    snapshot,
    ["resourceLoaded"],
    (event) =>
      identity(event).contextId === detail.contextId &&
      event.details.path === "detail.lynx.bundle" &&
      typeof event.details.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(event.details.sha256) &&
      (options.detailSha256 === undefined ||
        event.details.sha256 === options.detailSha256),
    "verified detail resource",
  );
  if (
    (options.platform === "ios"
      ? compareGenerationEventSequence(resource.sequence, opened.sequence) >= 0
      : compareGenerationEventSequence(opened.sequence, resource.sequence) >=
        0) ||
    compareGenerationEventSequence(resource.sequence, firstContent.sequence) >=
      0 ||
    compareGenerationEventSequence(firstContent.sequence, admitted.sequence) >=
      0 ||
    (options.platform === "ios"
      ? compareGenerationEventSequence(terminal.sequence, admitted.sequence) >=
        0
      : compareGenerationEventSequence(admitted.sequence, terminal.sequence) >=
        0) ||
    pageAttemptId.length === 0
  ) {
    throw new Error("Detail resource/content/admission order is invalid");
  }
  return detail;
}

export function assertManagedDetailClosed(
  snapshot: GenerationEventsSnapshot,
  options: {
    readonly platform: "ios" | "android";
    readonly detail: ManagedPageIdentity;
    readonly cause: "back" | "close";
  },
): void {
  const closed = requireEvent(
    snapshot,
    options.platform === "ios"
      ? [options.cause === "back" ? "nativeBack" : "pageClosed"]
      : ["routeClosed"],
    (event) => {
      const nativeCause = options.cause === "close" ? "router.close" : "back";
      return (
        identity(event).contextId === options.detail.contextId &&
        event.details.outcome ===
          (options.platform === "ios" && options.cause === "back"
            ? "nativeBack"
            : "closed") &&
        (options.platform === "ios" || event.details.cause === nativeCause)
      );
    },
    `detail ${options.cause}`,
  );
  if (
    JSON.stringify(closed.details.orderedPageEntries) !==
      JSON.stringify(["main.lynx.bundle"]) ||
    closed.details.topPageEntry !== "main.lynx.bundle"
  ) {
    throw new Error("Detail close did not reveal the managed main page");
  }
}

export function assertManagedDetailPending(
  snapshot: GenerationEventsSnapshot,
  options: {
    readonly platform: "ios" | "android";
    readonly main: ManagedPageIdentity;
  },
): ManagedPendingPageIdentity {
  const opened = snapshot.events.findLast(
    (event) =>
      (options.platform === "ios"
        ? event.name === "pageOpened"
        : event.name === "routeOpened") &&
      event.details.pageEntry === "detail.lynx.bundle" &&
      event.details.sourceContextId === options.main.contextId &&
      event.details.outcome === "opened",
  );
  if (!opened) throw new Error("Missing authentic pending detail open event");
  assertNativePageClass(opened, options.platform);
  const pending: ManagedPendingPageIdentity = {
    ...identity(opened),
    pageAttemptId: string(
      opened.details.pageAttemptId,
      `${opened.name}.pageAttemptId`,
    ),
  };
  if (!sameSelection(pending, options.main)) {
    throw new Error("Pending detail does not belong to the running Release");
  }
  requireEvent(
    snapshot,
    ["firstContent"],
    (event) => identity(event).contextId === pending.contextId,
    "pending detail firstContent",
  );
  if (
    snapshot.events.some(
      (event) =>
        event.details.pageAttemptId === pending.pageAttemptId &&
        ["pageAdmitted", "pageAttemptTerminal"].includes(event.name),
    )
  ) {
    throw new Error(
      "Pending detail already reached admission or terminal state",
    );
  }
  return pending;
}

export function assertManagedPageTerminal(
  snapshot: GenerationEventsSnapshot,
  pending: ManagedPendingPageIdentity,
  expected: {
    readonly reason?: string;
    readonly terminal:
      | "authorized-cancel"
      | "process-interruption"
      | "verified-fatal";
    readonly transitionId?: string;
  },
): GenerationEvent {
  const terminal = requireEvent(
    snapshot,
    ["pageAttemptTerminal"],
    (event) =>
      event.details.pageAttemptId === pending.pageAttemptId &&
      event.details.terminal === expected.terminal,
    `${expected.terminal} page terminal`,
  );
  if (!sameSelection(identity(terminal), pending)) {
    throw new Error("Page terminal lost its managed Release identity");
  }
  if (
    expected.reason !== undefined &&
    terminal.details.reason !== expected.reason
  ) {
    throw new Error(`Page terminal reason is not ${expected.reason}`);
  }
  if (
    expected.transitionId !== undefined &&
    terminal.details.transitionId !== expected.transitionId
  ) {
    throw new Error("Page terminal did not retain the accepted transition ID");
  }
  const matching = snapshot.events.filter(
    (event) =>
      event.name === "pageAttemptTerminal" &&
      event.details.pageAttemptId === pending.pageAttemptId,
  );
  if (matching.length !== 1) {
    throw new Error(
      "Page attempt must have exactly one durable terminal state",
    );
  }
  return terminal;
}

export function assertManagedReconstructedStack(
  snapshot: GenerationEventsSnapshot,
  options: {
    readonly platform: "ios" | "android";
    readonly previous?: {
      readonly detail: ManagedPageIdentity;
      readonly main: ManagedPageIdentity;
    };
    readonly selection: ManagedSelection;
  },
): {
  readonly detail: ManagedPageIdentity;
  readonly main: ManagedPageIdentity;
} {
  const started = snapshot.events.findLast(
    (event) =>
      event.name === "generationStarted" &&
      event.details.bundleId === options.selection.bundleId &&
      event.details.releaseId === options.selection.releaseId &&
      JSON.stringify(event.details.orderedPageEntries) ===
        JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]) &&
      event.details.topPageEntry === "detail.lynx.bundle",
  );
  if (!started) {
    throw new Error("Missing authentic reconstructed two-page generation");
  }
  const main = identity(started);
  const contextIds = strings(started.details.contextIds, "contextIds");
  if (contextIds.length !== 2 || contextIds[0] !== main.contextId) {
    throw new Error(
      "Reconstructed generation must contain two ordered contexts",
    );
  }
  const orderedParameters = started.details.orderedPageParameters;
  if (!Array.isArray(orderedParameters) || orderedParameters.length !== 2) {
    throw new Error("Reconstructed generation omitted ordered page parameters");
  }
  const detailParameters = orderedParameters[1];
  const parametersMatch =
    (Array.isArray(detailParameters) &&
      detailParameters.length === 1 &&
      record(detailParameters[0], "detail ordered parameter").name ===
        "title" &&
      record(detailParameters[0], "detail ordered parameter").value ===
        "Second Page") ||
    (!Array.isArray(detailParameters) &&
      record(detailParameters, "detail ordered parameters").title ===
        "Second Page");
  if (!parametersMatch) {
    throw new Error("Reconstructed detail parameters changed");
  }
  const detail = assertManagedDetailOpened(snapshot, {
    platform: options.platform,
    main,
  });
  if (
    options.previous &&
    (main.contextId === options.previous.main.contextId ||
      detail.contextId === options.previous.detail.contextId)
  ) {
    throw new Error("Reconstruction reused a retired page context");
  }
  return { detail, main };
}

export function assertManagedPendingTransition(
  snapshot: GenerationEventsSnapshot,
  options: {
    readonly after: ManagedSelection;
    readonly before: ManagedPageIdentity;
    readonly pending: ManagedPendingPageIdentity;
    readonly platform: "ios" | "android";
  },
) {
  const transitionId = assertManagedTransitionCancellation(
    snapshot,
    options.before,
    options.pending,
  );
  const started = snapshot.events.findLast(
    (event) =>
      event.name === "generationStarted" &&
      event.details.transitionId === transitionId &&
      event.details.bundleId === options.after.bundleId &&
      event.details.releaseId === options.after.releaseId &&
      JSON.stringify(event.details.orderedPageEntries) ===
        JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]),
  );
  if (!started) {
    throw new Error(
      "Pending-page transition did not reconstruct the full stack",
    );
  }
  const main = identity(started);
  const nextPending = assertManagedDetailPending(snapshot, {
    platform: options.platform,
    main,
  });
  if (nextPending.pageAttemptId === options.pending.pageAttemptId) {
    throw new Error("Pending-page transition reused the old page attempt");
  }
  return { main, pending: nextPending, transitionId };
}

export function assertManagedTransitionCancellation(
  snapshot: GenerationEventsSnapshot,
  before: ManagedPageIdentity,
  pending: ManagedPendingPageIdentity,
): string {
  const accepted = snapshot.events.findLast(
    (event) =>
      event.name === "transitionAccepted" &&
      event.details.contextId === before.contextId &&
      event.details.status === "TRANSITION_ACCEPTED",
  );
  if (!accepted) {
    throw new Error("Missing authentic pending-page transition acceptance");
  }
  const transitionId = string(
    accepted.details.transitionId,
    "transitionAccepted.transitionId",
  );
  assertManagedPageTerminal(snapshot, pending, {
    reason: "managedTransition",
    terminal: "authorized-cancel",
    transitionId,
  });
  return transitionId;
}

export function assertManagedVerifiedFatalDetail(
  snapshot: GenerationEventsSnapshot,
  selection: ManagedSelection,
  platform: "ios" | "android",
  sourceMain?: ManagedPageIdentity,
): ManagedPendingPageIdentity {
  const terminal = snapshot.events.findLast(
    (event) =>
      event.name === "pageAttemptTerminal" &&
      event.details.pageEntry === "detail.lynx.bundle" &&
      event.details.terminal === "verified-fatal" &&
      event.details.bundleId === selection.bundleId &&
      event.details.releaseId === selection.releaseId,
  );
  if (!terminal) throw new Error("Missing authentic verified detail fatal");
  const failed: ManagedPendingPageIdentity = {
    ...identity(terminal),
    pageAttemptId: string(
      terminal.details.pageAttemptId,
      "pageAttemptTerminal.pageAttemptId",
    ),
  };
  assertNativePageClass(terminal, platform);
  if (
    JSON.stringify(terminal.details.orderedPageEntries) !==
      JSON.stringify(["main.lynx.bundle", "detail.lynx.bundle"]) ||
    terminal.details.topPageEntry !== "detail.lynx.bundle" ||
    typeof terminal.details.sourceContextId !== "string" ||
    terminal.details.sourceContextId.length === 0
  ) {
    throw new Error("Verified detail fatal lost its retained native stack");
  }
  if (
    sourceMain &&
    (terminal.details.sourceContextId !== sourceMain.contextId ||
      !sameSelection(failed, sourceMain))
  ) {
    throw new Error("Verified detail fatal came from another main page");
  }
  const evaluating = requireEvent(
    snapshot,
    ["generationWillEvaluate"],
    (event) => identity(event).contextId === failed.contextId,
    "detail generationWillEvaluate",
  );
  const resource = requireEvent(
    snapshot,
    ["resourceLoaded"],
    (event) =>
      identity(event).contextId === failed.contextId &&
      event.details.path === "detail.lynx.bundle" &&
      typeof event.details.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(event.details.sha256),
    "verified detail resource",
  );
  const firstContent = requireEvent(
    snapshot,
    ["firstContent"],
    (event) => identity(event).contextId === failed.contextId,
    "verified detail firstContent",
  );
  const runtimeFailed = requireEvent(
    snapshot,
    ["runtimeFailed"],
    (event) => identity(event).contextId === failed.contextId,
    "detail runtimeFailed",
  );
  const generationFailed = requireEvent(
    snapshot,
    ["generationFailed"],
    (event) => identity(event).contextId === failed.contextId,
    "detail generationFailed",
  );
  if (
    compareGenerationEventSequence(evaluating.sequence, resource.sequence) >=
      0 ||
    compareGenerationEventSequence(resource.sequence, firstContent.sequence) >=
      0 ||
    compareGenerationEventSequence(
      firstContent.sequence,
      runtimeFailed.sequence,
    ) >= 0 ||
    compareGenerationEventSequence(runtimeFailed.sequence, terminal.sequence) >=
      0 ||
    compareGenerationEventSequence(
      terminal.sequence,
      generationFailed.sequence,
    ) >= 0
  ) {
    throw new Error("Verified detail fatal events are out of durable order");
  }
  if (
    snapshot.events.some(
      (event) =>
        event.name === "pageAdmitted" &&
        event.details.pageAttemptId === failed.pageAttemptId,
    )
  ) {
    throw new Error("A verified-fatal detail was also admitted");
  }
  return failed;
}

export function assertManagedOldAuthoritiesRejected(
  snapshot: GenerationEventsSnapshot,
  retired: readonly ManagedPageIdentity[],
): void {
  for (const page of retired) {
    requireEvent(
      snapshot,
      ["staleContextRejected"],
      (event) =>
        event.details.code === "STALE_CONTEXT" &&
        event.details.generationId === page.generationId &&
        event.details.contextId === page.contextId &&
        event.details.attemptId === page.attemptId &&
        event.details.bundleId === page.bundleId &&
        event.details.releaseId === page.releaseId,
      `retired context ${page.contextId} rejection`,
    );
  }
}

export function assertManagedTransition(
  snapshot: GenerationEventsSnapshot,
  options: {
    readonly before: ManagedPageIdentity;
    readonly after: ManagedSelection;
  },
): ManagedPageIdentity {
  const accepted = requireEvent(
    snapshot,
    ["transitionAccepted"],
    (event) =>
      event.details.contextId === options.before.contextId &&
      event.details.status === "TRANSITION_ACCEPTED",
    "transition acceptance",
  );
  const transitionId = string(
    accepted.details.transitionId,
    "transitionAccepted.transitionId",
  );
  const started = requireEvent(
    snapshot,
    ["generationStarted"],
    (event) =>
      compareGenerationEventSequence(event.sequence, accepted.sequence) > 0 &&
      event.details.transitionId === transitionId &&
      event.details.bundleId === options.after.bundleId &&
      event.details.releaseId === options.after.releaseId,
    "replacement generation",
  );
  const after = identity(started);
  if (
    after.processId !== options.before.processId ||
    after.generationId === options.before.generationId ||
    after.contextId === options.before.contextId
  ) {
    throw new Error(
      "Managed transition did not replace contexts in one process",
    );
  }
  return after;
}

export function assertManagedInstallRejected(
  before: GenerationEventsSnapshot,
  after: GenerationEventsSnapshot,
  options: {
    readonly rejected: ManagedSelection;
    readonly running: ManagedPageIdentity;
  },
): void {
  const baseline = before.latestSequence;
  if (baseline === null) {
    throw new Error("Install rejection evidence requires a native baseline");
  }
  const newEvents = after.events.filter(
    (event) => compareGenerationEventSequence(event.sequence, baseline) > 0,
  );
  if (
    newEvents.some(
      (event) =>
        event.name === "generationStarted" &&
        event.details.bundleId === options.rejected.bundleId &&
        event.details.releaseId === options.rejected.releaseId,
    )
  ) {
    throw new Error("Rejected multi-page target started a native generation");
  }
  if (
    newEvents.some(
      (event) =>
        ["transitionAccepted", "generationWillRetire"].includes(event.name) &&
        event.details.generationId === options.running.generationId,
    )
  ) {
    throw new Error("Rejected multi-page target retired the running Release");
  }
}
