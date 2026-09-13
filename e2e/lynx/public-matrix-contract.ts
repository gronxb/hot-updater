export const LYNX_MATRIX_FRAMEWORKS = ["react", "vue", "octane"] as const;
export const LYNX_MATRIX_PLATFORMS = ["ios", "android"] as const;
export const LYNX_MATRIX_RESOURCE_PATHS = [
  "main.lynx.bundle",
  "assets/probe.png",
  "assets/probe.ttf",
  "assets/bootstrap.js",
  "dynamic/component.lynx.bundle",
] as const;

export type LynxMatrixFramework = (typeof LYNX_MATRIX_FRAMEWORKS)[number];
export type LynxMatrixPlatform = (typeof LYNX_MATRIX_PLATFORMS)[number];

type JsonRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`Invalid Lynx matrix receipt at ${path}: ${message}`);
}

function record(value: unknown, at: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(at, "expected an object");
  }
  return value as JsonRecord;
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(at, "expected a non-empty string");
  }
  return value;
}

function nullableString(value: unknown, at: string): string | null {
  if (value === null) return null;
  return string(value, at);
}

function exactString(value: unknown, expected: string, at: string): void {
  if (value !== expected) fail(at, `expected ${JSON.stringify(expected)}`);
}

function boolean(value: unknown, expected: boolean, at: string): void {
  if (value !== expected) fail(at, `expected ${expected}`);
}

function booleanValue(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") fail(at, "expected a boolean");
  return value;
}

function sequence(value: unknown, at: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(at, "expected a non-negative event sequence");
  }
  return value as number;
}

function hash(value: unknown, at: string): string {
  const result = string(value, at);
  if (!/^[a-f0-9]{64}$/.test(result)) fail(at, "expected a SHA-256 hash");
  return result;
}

function stringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(at, "expected an array of strings");
  }
  return value as string[];
}

function sameMembers(
  actual: string[],
  expected: readonly string[],
  at: string,
) {
  if (
    actual.length !== new Set(actual).size ||
    actual.length !== expected.length ||
    actual.some((value) => !expected.includes(value))
  ) {
    fail(at, `expected exactly ${JSON.stringify(expected)}`);
  }
}

function selection(value: unknown, at: string) {
  const item = record(value, at);
  return {
    bundleId: string(item.bundleId, `${at}.bundleId`),
    releaseId: string(item.releaseId, `${at}.releaseId`),
  };
}

function selectionSummary(value: unknown, at: string) {
  const item = record(value, at);
  const kind = string(item.kind, `${at}.kind`);
  if (kind !== "BUNDLE" && kind !== "EMBEDDED" && kind !== "BUILTIN") {
    fail(`${at}.kind`, "expected BUNDLE, EMBEDDED, or BUILTIN");
  }
  return {
    kind,
    bundleId: string(item.bundleId, `${at}.bundleId`),
    releaseId: nullableString(item.releaseId, `${at}.releaseId`),
    channel: string(item.channel, `${at}.channel`),
  };
}

type ExpectedSelection = {
  bundleId: string;
  releaseId: string | null;
};

function nativeConfirmation(
  value: unknown,
  expectedStatus: "CONFIRMED" | "ALREADY_CONFIRMED",
  expectedTransition: null | {
    kind: "UPDATE_APPLIED" | "RECOVERED";
    from: ExpectedSelection;
    to: ExpectedSelection;
  },
  at: string,
) {
  const item = record(value, at);
  exactString(item.status, expectedStatus, `${at}.status`);
  if (expectedTransition === null) {
    if (item.transition !== null) {
      fail(`${at}.transition`, "expected no native launch transition");
    }
    return;
  }
  const transition = record(item.transition, `${at}.transition`);
  exactString(
    transition.kind,
    expectedTransition.kind,
    `${at}.transition.kind`,
  );
  const from = selectionSummary(transition.from, `${at}.transition.from`);
  const to = selectionSummary(transition.to, `${at}.transition.to`);
  if (from.bundleId === to.bundleId || from.releaseId === to.releaseId) {
    fail(
      `${at}.transition`,
      "from and to must have distinct bundle and release identities",
    );
  }
  if (
    from.bundleId !== expectedTransition.from.bundleId ||
    from.releaseId !== expectedTransition.from.releaseId
  ) {
    fail(`${at}.transition.from`, "does not match the prior native selection");
  }
  if (
    to.bundleId !== expectedTransition.to.bundleId ||
    to.releaseId !== expectedTransition.to.releaseId
  ) {
    fail(`${at}.transition.to`, "does not match the launched candidate");
  }
}

function identity(value: unknown, at: string) {
  const item = record(value, at);
  return {
    processId: string(item.processId, `${at}.processId`),
    generationId: string(item.generationId, `${at}.generationId`),
    contextId: string(item.contextId, `${at}.contextId`),
    attemptId: string(item.attemptId, `${at}.attemptId`),
    bundleId: string(item.bundleId, `${at}.bundleId`),
    releaseId: nullableString(item.releaseId, `${at}.releaseId`),
  };
}

function resources(value: unknown, expected: JsonRecord, at: string) {
  if (!Array.isArray(value)) fail(at, "expected an array");
  const paths = value.map((raw, index) => {
    const itemAt = `${at}[${index}]`;
    const item = record(raw, itemAt);
    const resourcePath = string(item.path, `${itemAt}.path`);
    if (!LYNX_MATRIX_RESOURCE_PATHS.includes(resourcePath as never)) {
      fail(`${itemAt}.path`, `unexpected resource ${resourcePath}`);
    }
    const expectedResource = record(
      expected[resourcePath],
      `build.files.${resourcePath}`,
    );
    const expectedHash = hash(
      expectedResource.sha256,
      `build.files.${resourcePath}.sha256`,
    );
    const observedHash = hash(item.sha256, `${itemAt}.sha256`);
    if (observedHash !== expectedHash) {
      fail(
        `${itemAt}.sha256`,
        `does not match compiler output for ${resourcePath}`,
      );
    }
    const loadedSequence = sequence(
      item.loadedSequence,
      `${itemAt}.loadedSequence`,
    );
    boolean(item.leaseAcquired, true, `${itemAt}.leaseAcquired`);
    booleanValue(item.leaseReleased, `${itemAt}.leaseReleased`);
    const acquiredSequence = sequence(
      item.leaseAcquiredSequence,
      `${itemAt}.leaseAcquiredSequence`,
    );
    if (acquiredSequence > loadedSequence) {
      fail(itemAt, "resource lease must be acquired before resourceLoaded");
    }
    if (item.leaseReleased === true) {
      sequence(item.leaseReleasedSequence, `${itemAt}.leaseReleasedSequence`);
    } else if (item.leaseReleasedSequence !== null) {
      fail(`${itemAt}.leaseReleasedSequence`, "expected null without release");
    }
    return resourcePath;
  });
  sameMembers(paths, LYNX_MATRIX_RESOURCE_PATHS, at);
}

function launchMembers(
  value: unknown,
  contextIds: string[],
  primaryIdentity: ReturnType<typeof identity>,
  expectedBuild: JsonRecord,
  at: string,
  requireReady: boolean,
  confirmation: unknown,
) {
  if (!Array.isArray(value)) fail(at, "expected an array");
  let primaryMember: JsonRecord | undefined;
  const observedContextIds = value.map((raw, index) => {
    const memberAt = `${at}[${index}]`;
    const member = record(raw, memberAt);
    const memberIdentity = identity(member.identity, `${memberAt}.identity`);
    if (
      memberIdentity.processId !== primaryIdentity.processId ||
      memberIdentity.generationId !== primaryIdentity.generationId ||
      memberIdentity.attemptId !== primaryIdentity.attemptId ||
      memberIdentity.bundleId !== primaryIdentity.bundleId ||
      memberIdentity.releaseId !== primaryIdentity.releaseId
    ) {
      fail(`${memberAt}.identity`, "must belong to the declared generation");
    }
    boolean(
      member.primary,
      memberIdentity.contextId === primaryIdentity.contextId,
      `${memberAt}.primary`,
    );
    if (member.primary === true) primaryMember = member;
    boolean(
      member.readinessAuthority,
      memberIdentity.contextId === primaryIdentity.contextId,
      `${memberAt}.readinessAuthority`,
    );
    const firstContent = identity(
      member.firstContent,
      `${memberAt}.firstContent`,
    );
    if (JSON.stringify(firstContent) !== JSON.stringify(memberIdentity)) {
      fail(`${memberAt}.firstContent`, "must match the member identity");
    }
    const evaluationSequence = sequence(
      member.evaluationSequence,
      `${memberAt}.evaluationSequence`,
    );
    const firstContentSequence = sequence(
      member.firstContentSequence,
      `${memberAt}.firstContentSequence`,
    );
    if (evaluationSequence >= firstContentSequence) {
      fail(memberAt, "generationWillEvaluate must precede firstContent");
    }
    resources(
      member.resources,
      record(expectedBuild.files, "build.files"),
      `${memberAt}.resources`,
    );
    if (requireReady && member.primary === true) {
      record(member.confirmation, `${memberAt}.confirmation`);
      if (
        JSON.stringify(member.confirmation) !== JSON.stringify(confirmation)
      ) {
        fail(
          `${memberAt}.confirmation`,
          "must equal the primary generation confirmation receipt",
        );
      }
      const jsReady = identity(member.jsReady, `${memberAt}.jsReady`);
      if (JSON.stringify(jsReady) !== JSON.stringify(memberIdentity)) {
        fail(`${memberAt}.jsReady`, "must match the member identity");
      }
      const jsReadySequence = sequence(
        member.jsReadySequence,
        `${memberAt}.jsReadySequence`,
      );
      if (firstContentSequence >= jsReadySequence) {
        fail(memberAt, "firstContent must precede jsReady");
      }
      for (const resource of member.resources as JsonRecord[]) {
        if (sequence(resource.loadedSequence, memberAt) >= jsReadySequence) {
          fail(memberAt, "required resources must complete before jsReady");
        }
      }
    } else if (
      member.jsReady !== null ||
      member.jsReadySequence !== null ||
      member.confirmation !== null
    ) {
      fail(
        memberAt,
        "non-authoritative member must not contain jsReady evidence",
      );
    }
    return memberIdentity.contextId;
  });
  sameMembers(observedContextIds, contextIds, at);
  if (!primaryMember) fail(at, "missing the authoritative primary member");
  return primaryMember;
}

function readyLaunch(
  value: unknown,
  expectedBuild: JsonRecord,
  at: string,
  expectedSelection?: { bundleId: string; releaseId: string | null },
) {
  const item = record(value, at);
  const launchIdentity = identity(item.identity, `${at}.identity`);
  const firstContent = identity(item.firstContent, `${at}.firstContent`);
  const jsReady = identity(item.jsReady, `${at}.jsReady`);
  if (JSON.stringify(firstContent) !== JSON.stringify(launchIdentity)) {
    fail(`${at}.firstContent`, "must belong to the primary launch identity");
  }
  if (JSON.stringify(jsReady) !== JSON.stringify(launchIdentity)) {
    fail(`${at}.jsReady`, "must belong to the primary launch identity");
  }
  if (
    launchIdentity.bundleId !==
      string(expectedBuild.bundleId, "build.bundleId") ||
    launchIdentity.releaseId !==
      nullableString(expectedBuild.releaseId, "build.releaseId")
  ) {
    fail(`${at}.identity`, "does not match the expected release");
  }
  if (
    expectedSelection &&
    (launchIdentity.bundleId !== expectedSelection.bundleId ||
      launchIdentity.releaseId !== expectedSelection.releaseId)
  ) {
    fail(`${at}.identity`, "does not match the staged selection");
  }
  const contextIds = stringArray(item.contextIds, `${at}.contextIds`);
  if (
    contextIds.length < 2 ||
    contextIds.length !== new Set(contextIds).size ||
    !contextIds.includes(launchIdentity.contextId)
  ) {
    fail(
      `${at}.contextIds`,
      "must contain a unique primary and at least one managed secondary context",
    );
  }
  resources(
    item.resources,
    record(expectedBuild.files, "build.files"),
    `${at}.resources`,
  );
  const primaryMember = launchMembers(
    item.members,
    contextIds,
    launchIdentity,
    expectedBuild,
    `${at}.members`,
    true,
    item.confirmation,
  );
  for (const key of [
    "evaluationSequence",
    "firstContentSequence",
    "jsReadySequence",
    "firstContent",
    "jsReady",
    "confirmation",
    "resources",
  ]) {
    if (JSON.stringify(item[key]) !== JSON.stringify(primaryMember[key])) {
      fail(`${at}.${key}`, "must equal the authoritative primary member");
    }
  }
  const evaluationSequence = sequence(
    item.evaluationSequence,
    `${at}.evaluationSequence`,
  );
  const firstContentSequence = sequence(
    item.firstContentSequence,
    `${at}.firstContentSequence`,
  );
  const jsReadySequence = sequence(
    item.jsReadySequence,
    `${at}.jsReadySequence`,
  );
  if (
    evaluationSequence >= firstContentSequence ||
    firstContentSequence >= jsReadySequence
  ) {
    fail(
      at,
      "generationWillEvaluate must precede firstContent, which must precede jsReady",
    );
  }
  for (const [index, resource] of (item.resources as JsonRecord[]).entries()) {
    if (
      sequence(
        resource.loadedSequence,
        `${at}.resources[${index}].loadedSequence`,
      ) >= jsReadySequence
    ) {
      fail(
        `${at}.resources[${index}]`,
        "required resource must load before jsReady",
      );
    }
  }
  return {
    identity: launchIdentity,
    contextIds,
    resources: item.resources as JsonRecord[],
    members: item.members as JsonRecord[],
    confirmation: item.confirmation,
  };
}

function unconfirmedLaunch(
  value: unknown,
  expectedBuild: JsonRecord,
  at: string,
  expectedSelection: { bundleId: string; releaseId: string | null },
) {
  const item = record(value, at);
  const launchIdentity = identity(item.identity, `${at}.identity`);
  const firstContent = identity(item.firstContent, `${at}.firstContent`);
  if (JSON.stringify(firstContent) !== JSON.stringify(launchIdentity)) {
    fail(`${at}.firstContent`, "must belong to the primary launch identity");
  }
  if (
    launchIdentity.bundleId !==
      string(expectedBuild.bundleId, "build.bundleId") ||
    launchIdentity.releaseId !==
      nullableString(expectedBuild.releaseId, "build.releaseId") ||
    launchIdentity.bundleId !== expectedSelection.bundleId ||
    launchIdentity.releaseId !== expectedSelection.releaseId
  ) {
    fail(`${at}.identity`, "does not match the unconfirmed candidate");
  }
  const contextIds = stringArray(item.contextIds, `${at}.contextIds`);
  if (
    contextIds.length < 2 ||
    contextIds.length !== new Set(contextIds).size ||
    !contextIds.includes(launchIdentity.contextId)
  ) {
    fail(`${at}.contextIds`, "must declare a primary and managed secondary");
  }
  resources(
    item.resources,
    record(expectedBuild.files, "build.files"),
    `${at}.resources`,
  );
  const primaryMember = launchMembers(
    item.members,
    contextIds,
    launchIdentity,
    expectedBuild,
    `${at}.members`,
    false,
    item.confirmation,
  );
  for (const key of [
    "evaluationSequence",
    "firstContentSequence",
    "jsReadySequence",
    "firstContent",
    "jsReady",
    "confirmation",
    "resources",
  ]) {
    if (JSON.stringify(item[key]) !== JSON.stringify(primaryMember[key])) {
      fail(`${at}.${key}`, "must equal the authoritative primary member");
    }
  }
  const evaluationSequence = sequence(
    item.evaluationSequence,
    `${at}.evaluationSequence`,
  );
  const firstContentSequence = sequence(
    item.firstContentSequence,
    `${at}.firstContentSequence`,
  );
  if (evaluationSequence >= firstContentSequence) {
    fail(`${at}.firstContentSequence`, "must follow generationWillEvaluate");
  }
  boolean(item.readinessWithheld, true, `${at}.readinessWithheld`);
  if (
    item.jsReady !== null ||
    item.jsReadySequence !== null ||
    item.confirmation !== null
  ) {
    fail(at, "unconfirmed candidate must not contain jsReady evidence");
  }
  return {
    identity: launchIdentity,
    contextIds,
    resources: item.resources as JsonRecord[],
    members: item.members as JsonRecord[],
  };
}

function generationRetirement(
  value: unknown,
  before: ReturnType<typeof readyLaunch>,
  at: string,
  requireStaleAuthorities: boolean,
) {
  const item = record(value, at);
  exactString(item.leaseScope, "context", `${at}.leaseScope`);
  const contextIds = stringArray(item.contextIds, `${at}.contextIds`);
  sameMembers(contextIds, before.contextIds, `${at}.contextIds`);
  if (
    item.expectedLeaseCount !==
    before.contextIds.length * LYNX_MATRIX_RESOURCE_PATHS.length
  ) {
    fail(
      `${at}.expectedLeaseCount`,
      "must include one lease per managed context and required resource",
    );
  }
  if (item.inFlightResourceCount !== 0) {
    fail(
      `${at}.inFlightResourceCount`,
      "expected zero accepted resource requests at generationRetired",
    );
  }
  const willRetireSequence = sequence(
    item.willRetireSequence,
    `${at}.willRetireSequence`,
  );
  const retiredSequence = sequence(
    item.retiredSequence,
    `${at}.retiredSequence`,
  );
  if (retiredSequence <= willRetireSequence) {
    fail(at, "generationRetired must follow generationWillRetire");
  }
  boolean(item.allLeasesBalanced, true, `${at}.allLeasesBalanced`);
  if (item.lateOldContextEventCount !== 0) {
    fail(
      `${at}.lateOldContextEventCount`,
      "expected zero late old-context events",
    );
  }
  if (!Array.isArray(item.staleContextRejections)) {
    fail(`${at}.staleContextRejections`, "expected an array");
  }
  const rejectedContextIds = item.staleContextRejections.map((raw, index) => {
    const rejectionAt = `${at}.staleContextRejections[${index}]`;
    const rejection = record(raw, rejectionAt);
    exactString(rejection.code, "STALE_CONTEXT", `${rejectionAt}.code`);
    const rejectedIdentity = identity(rejection, rejectionAt);
    if (
      rejectedIdentity.processId !== before.identity.processId ||
      rejectedIdentity.generationId !== before.identity.generationId ||
      rejectedIdentity.attemptId !== before.identity.attemptId ||
      rejectedIdentity.bundleId !== before.identity.bundleId ||
      rejectedIdentity.releaseId !== before.identity.releaseId
    ) {
      fail(rejectionAt, "must retain the retired generation identity");
    }
    return rejectedIdentity.contextId;
  });
  if (requireStaleAuthorities) {
    sameMembers(
      rejectedContextIds,
      before.contextIds,
      `${at}.staleContextRejections`,
    );
  } else if (rejectedContextIds.length !== 0) {
    fail(`${at}.staleContextRejections`, "expected no diagnostic probes");
  }
  boolean(
    item.oldContextsInvalidated,
    requireStaleAuthorities,
    `${at}.oldContextsInvalidated`,
  );
  for (const [memberIndex, rawMember] of before.members.entries()) {
    const member = record(rawMember, `${at}.members[${memberIndex}]`);
    if (!Array.isArray(member.resources)) {
      fail(`${at}.members[${memberIndex}].resources`, "expected an array");
    }
    for (const [resourceIndex, rawResource] of member.resources.entries()) {
      const resourceAt = `${at}.members[${memberIndex}].resources[${resourceIndex}]`;
      const resource = record(rawResource, resourceAt);
      boolean(resource.leaseReleased, true, `${resourceAt}.leaseReleased`);
      const acquired = sequence(
        resource.leaseAcquiredSequence,
        `${resourceAt}.leaseAcquiredSequence`,
      );
      const released = sequence(
        resource.leaseReleasedSequence,
        `${resourceAt}.leaseReleasedSequence`,
      );
      if (
        acquired >= willRetireSequence ||
        released <= willRetireSequence ||
        released >= retiredSequence
      ) {
        fail(
          resourceAt,
          "lease must be acquired before retirement, then released before generationRetired",
        );
      }
    }
  }
  return { contextIds, willRetireSequence, retiredSequence };
}

function build(
  value: unknown,
  variant: string,
  at: string,
  allowEmbeddedRelease = false,
) {
  const item = record(value, at);
  exactString(item.variant, variant, `${at}.variant`);
  string(item.compiler, `${at}.compiler`);
  string(item.compilerVersion, `${at}.compilerVersion`);
  string(item.runtimeId, `${at}.runtimeId`);
  string(item.bundleId, `${at}.bundleId`);
  if (allowEmbeddedRelease) nullableString(item.releaseId, `${at}.releaseId`);
  else string(item.releaseId, `${at}.releaseId`);
  hash(item.manifestSha256, `${at}.manifestSha256`);
  const files = record(item.files, `${at}.files`);
  sameMembers(Object.keys(files), LYNX_MATRIX_RESOURCE_PATHS, `${at}.files`);
  for (const path of LYNX_MATRIX_RESOURCE_PATHS) {
    const file = record(files[path], `${at}.files.${path}`);
    hash(file.sha256, `${at}.files.${path}.sha256`);
    if (
      !Number.isSafeInteger(file.byteSize) ||
      (file.byteSize as number) <= 0
    ) {
      fail(`${at}.files.${path}.byteSize`, "expected a positive integer");
    }
  }
  return item;
}

function recovery(
  value: unknown,
  kind: "fatal" | "unconfirmed",
  candidateBuild: JsonRecord,
  stableBuild: JsonRecord,
  at: string,
) {
  const item = record(value, at);
  exactString(item.kind, kind, `${at}.kind`);
  const candidate = selection(item.candidate, `${at}.candidate`);
  if (
    candidate.bundleId === stableBuild.bundleId ||
    candidate.releaseId === stableBuild.releaseId
  ) {
    fail(`${at}.candidate`, "failed candidate must differ from stable release");
  }
  const failedAttemptId = string(item.failedAttemptId, `${at}.failedAttemptId`);
  const failureEvent = identity(item.failureEvent, `${at}.failureEvent`);
  if (
    failureEvent.attemptId !== failedAttemptId ||
    failureEvent.bundleId !== candidate.bundleId ||
    failureEvent.releaseId !== candidate.releaseId
  ) {
    fail(`${at}.failureEvent`, "must identify the failed candidate attempt");
  }
  const candidateLaunch = unconfirmedLaunch(
    item.candidateLaunch,
    candidateBuild,
    `${at}.candidateLaunch`,
    candidate,
  );
  if (
    failureEvent.processId !== candidateLaunch.identity.processId ||
    failureEvent.generationId !== candidateLaunch.identity.generationId ||
    failureEvent.attemptId !== candidateLaunch.identity.attemptId ||
    !candidateLaunch.contextIds.includes(failureEvent.contextId)
  ) {
    fail(`${at}.failureEvent`, "must belong to the candidate generation");
  }
  if (kind === "fatal") {
    exactString(
      item.failureEvent.event,
      "runtimeFailed",
      `${at}.failureEvent.event`,
    );
    const runtimeFailedSequence = sequence(
      item.failureEvent.runtimeFailedSequence,
      `${at}.failureEvent.runtimeFailedSequence`,
    );
    const generationFailedSequence = sequence(
      item.failureEvent.generationFailedSequence,
      `${at}.failureEvent.generationFailedSequence`,
    );
    if (runtimeFailedSequence >= generationFailedSequence) {
      fail(`${at}.failureEvent`, "runtimeFailed must precede generationFailed");
    }
    if (
      failureEvent.processId !== candidateLaunch.identity.processId ||
      failureEvent.generationId !== candidateLaunch.identity.generationId ||
      failureEvent.attemptId !== candidateLaunch.identity.attemptId ||
      failureEvent.contextId === candidateLaunch.identity.contextId ||
      !candidateLaunch.contextIds.includes(failureEvent.contextId)
    ) {
      fail(
        `${at}.failureEvent`,
        "must be attributed to the managed secondary candidate context",
      );
    }
    generationRetirement(
      item.generationRetirement,
      candidateLaunch,
      `${at}.generationRetirement`,
      false,
    );
  } else {
    exactString(
      item.failureEvent.event,
      "generationWillEvaluate",
      `${at}.failureEvent.event`,
    );
  }
  const recovered = readyLaunch(item.recovered, stableBuild, `${at}.recovered`);
  nativeConfirmation(
    recovered.confirmation,
    "ALREADY_CONFIRMED",
    {
      kind: "RECOVERED",
      from: candidate,
      to: {
        bundleId: string(stableBuild.bundleId, "stableBuild.bundleId"),
        releaseId: nullableString(
          stableBuild.releaseId,
          "stableBuild.releaseId",
        ),
      },
    },
    `${at}.recovered.confirmation`,
  );
  if (kind === "fatal") {
    if (
      recovered.identity.processId !== candidateLaunch.identity.processId ||
      recovered.identity.generationId ===
        candidateLaunch.identity.generationId ||
      candidateLaunch.contextIds.some((contextId) =>
        recovered.contextIds.includes(contextId),
      )
    ) {
      fail(
        `${at}.recovered`,
        "must replace the complete fatal generation in the same OS process",
      );
    }
  } else if (
    recovered.identity.processId === candidateLaunch.identity.processId
  ) {
    fail(`${at}.recovered`, "unconfirmed recovery must follow an OS relaunch");
  }
  const excluded = stringArray(
    item.persistedExclusions,
    `${at}.persistedExclusions`,
  );
  const excludedId =
    kind === "fatal" ? candidate.bundleId : candidate.releaseId;
  if (!excluded.includes(excludedId)) {
    fail(`${at}.persistedExclusions`, `must contain ${excludedId}`);
  }
  boolean(item.candidateRetried, false, `${at}.candidateRetried`);
  return recovered;
}

export function validateLynxMatrixCell(value: unknown): void {
  const cell = record(value, "cell");
  exactString(
    cell.schemaVersion,
    "lynx-public-matrix-v1",
    "cell.schemaVersion",
  );
  const framework = string(cell.framework, "cell.framework");
  const platform = string(cell.platform, "cell.platform");
  if (!LYNX_MATRIX_FRAMEWORKS.includes(framework as never)) {
    fail("cell.framework", "expected react, vue, or octane");
  }
  if (!LYNX_MATRIX_PLATFORMS.includes(platform as never)) {
    fail("cell.platform", "expected ios or android");
  }
  exactString(cell.cellId, `${framework}-${platform}`, "cell.cellId");
  string(cell.commit, "cell.commit");
  const binary = record(cell.binary, "cell.binary");
  string(binary.path, "cell.binary.path");
  const installedHash = hash(
    binary.installedSha256,
    "cell.binary.installedSha256",
  );
  const finalHash = hash(binary.finalSha256, "cell.binary.finalSha256");
  if (installedHash !== finalHash) {
    fail(
      "cell.binary.finalSha256",
      "native binary changed during the scenario",
    );
  }

  const builds = record(cell.builds, "cell.builds");
  const a = build(builds.A, "A", "cell.builds.A", true);
  if (a.releaseId !== null) {
    fail("cell.builds.A.releaseId", "embedded BUILTIN releaseId must be null");
  }
  const b = build(builds.B, "B", "cell.builds.B");
  const c = build(builds.C, "C", "cell.builds.C");
  const fatal = build(builds.fatal, "FATAL", "cell.builds.fatal");
  const unconfirmed = build(
    builds.unconfirmed,
    "UNCONFIRMED",
    "cell.builds.unconfirmed",
  );
  const runtimeIds = [a, b, c, fatal, unconfirmed].map(
    (item) => item.runtimeId,
  );
  if (new Set(runtimeIds).size !== 1) {
    fail("cell.builds", "all artifacts must use the same runtimeId");
  }
  if (
    new Set([c.bundleId, fatal.bundleId, unconfirmed.bundleId]).size !== 3 ||
    new Set([c.releaseId, fatal.releaseId, unconfirmed.releaseId]).size !== 3
  ) {
    fail(
      "cell.builds",
      "C, fatal, and unconfirmed candidates must have distinct real identities",
    );
  }

  const phases = record(cell.phases, "cell.phases");
  const embeddedA = readyLaunch(phases.embeddedA, a, "cell.phases.embeddedA");
  nativeConfirmation(
    embeddedA.confirmation,
    "CONFIRMED",
    null,
    "cell.phases.embeddedA.confirmation",
  );
  const archive = record(phases.archiveB, "cell.phases.archiveB");
  exactString(archive.transport, "archive", "cell.phases.archiveB.transport");
  boolean(
    archive.archiveFallbackUsed,
    false,
    "cell.phases.archiveB.archiveFallbackUsed",
  );
  hash(archive.archiveSha256, "cell.phases.archiveB.archiveSha256");
  const stagedB = selection(
    archive.stagedSelection,
    "cell.phases.archiveB.stagedSelection",
  );
  if (stagedB.bundleId !== b.bundleId || stagedB.releaseId !== b.releaseId) {
    fail("cell.phases.archiveB.stagedSelection", "must identify build B");
  }

  const offline = record(phases.offline, "cell.phases.offline");
  const probe = record(offline.originProbe, "cell.phases.offline.originProbe");
  exactString(
    probe.outcome,
    "connection-refused",
    "cell.phases.offline.originProbe.outcome",
  );
  string(probe.url, "cell.phases.offline.originProbe.url");
  string(probe.observedAt, "cell.phases.offline.originProbe.observedAt");
  const activation = readyLaunch(
    offline.activationB,
    b,
    "cell.phases.offline.activationB",
    stagedB,
  );
  const retain = readyLaunch(
    offline.retainB,
    b,
    "cell.phases.offline.retainB",
    stagedB,
  );
  nativeConfirmation(
    activation.confirmation,
    "CONFIRMED",
    {
      kind: "UPDATE_APPLIED",
      from: {
        bundleId: string(a.bundleId, "cell.builds.A.bundleId"),
        releaseId: nullableString(a.releaseId, "cell.builds.A.releaseId"),
      },
      to: stagedB,
    },
    "cell.phases.offline.activationB.confirmation",
  );
  nativeConfirmation(
    retain.confirmation,
    "ALREADY_CONFIRMED",
    null,
    "cell.phases.offline.retainB.confirmation",
  );
  if (activation.identity.processId === retain.identity.processId) {
    fail("cell.phases.offline", "B retain must be a later OS process");
  }
  boolean(
    offline.originStayedDown,
    true,
    "cell.phases.offline.originStayedDown",
  );

  const delta = record(phases.deltaC, "cell.phases.deltaC");
  const delivery = record(delta.delivery, "cell.phases.deltaC.delivery");
  exactString(
    delivery.transport,
    "bsdiff",
    "cell.phases.deltaC.delivery.transport",
  );
  exactString(
    delivery.algorithm,
    "bsdiff",
    "cell.phases.deltaC.delivery.algorithm",
  );
  string(delivery.transactionId, "cell.phases.deltaC.delivery.transactionId");
  exactString(
    delivery.baseBundleId,
    string(b.bundleId, "cell.builds.B.bundleId"),
    "cell.phases.deltaC.delivery.baseBundleId",
  );
  exactString(
    delivery.targetBundleId,
    string(c.bundleId, "cell.builds.C.bundleId"),
    "cell.phases.deltaC.delivery.targetBundleId",
  );
  boolean(
    delivery.archiveFallbackUsed,
    false,
    "cell.phases.deltaC.delivery.archiveFallbackUsed",
  );
  hash(delivery.patchSha256, "cell.phases.deltaC.delivery.patchSha256");
  hash(delivery.baseSha256, "cell.phases.deltaC.delivery.baseSha256");
  hash(delivery.targetSha256, "cell.phases.deltaC.delivery.targetSha256");
  hash(
    delivery.reconstructedSha256,
    "cell.phases.deltaC.delivery.reconstructedSha256",
  );
  if (delivery.reconstructedSha256 !== delivery.targetSha256) {
    fail(
      "cell.phases.deltaC.delivery.reconstructedSha256",
      "must equal targetSha256",
    );
  }
  const before = readyLaunch(
    delta.beforeReload,
    b,
    "cell.phases.deltaC.beforeReload",
    stagedB,
  );
  const after = readyLaunch(
    delta.afterReload,
    c,
    "cell.phases.deltaC.afterReload",
  );
  nativeConfirmation(
    after.confirmation,
    "CONFIRMED",
    {
      kind: "UPDATE_APPLIED",
      from: {
        bundleId: string(b.bundleId, "cell.builds.B.bundleId"),
        releaseId: nullableString(b.releaseId, "cell.builds.B.releaseId"),
      },
      to: {
        bundleId: string(c.bundleId, "cell.builds.C.bundleId"),
        releaseId: nullableString(c.releaseId, "cell.builds.C.releaseId"),
      },
    },
    "cell.phases.deltaC.afterReload.confirmation",
  );
  if (before.identity.processId !== after.identity.processId) {
    fail("cell.phases.deltaC", "HotUpdater.reload() changed the OS process");
  }
  if (before.identity.generationId === after.identity.generationId) {
    fail(
      "cell.phases.deltaC",
      "HotUpdater.reload() reused the managed generation",
    );
  }
  if (
    before.contextIds.some((contextId) => after.contextIds.includes(contextId))
  ) {
    fail(
      "cell.phases.deltaC.afterReload.contextIds",
      "fresh generation must replace every primary and secondary context ID",
    );
  }
  if (before.resources.some((resource) => resource.leaseReleased !== true)) {
    fail(
      "cell.phases.deltaC.beforeReload.resources",
      "all old-generation resource leases must drain during reload",
    );
  }
  generationRetirement(
    delta.generationRetirement,
    before,
    "cell.phases.deltaC.generationRetirement",
    true,
  );
  const primaryLifecycle = record(
    phases.primaryLifecycle,
    "cell.phases.primaryLifecycle",
  );
  const beforePrimaryRemoval = readyLaunch(
    primaryLifecycle.beforeRemoval,
    c,
    "cell.phases.primaryLifecycle.beforeRemoval",
  );
  if (
    JSON.stringify(beforePrimaryRemoval.identity) !==
      JSON.stringify(after.identity) ||
    JSON.stringify(beforePrimaryRemoval.contextIds) !==
      JSON.stringify(after.contextIds)
  ) {
    fail(
      "cell.phases.primaryLifecycle.beforeRemoval",
      "must be the live generation produced by the B to C reload",
    );
  }
  generationRetirement(
    primaryLifecycle.generationRetirement,
    beforePrimaryRemoval,
    "cell.phases.primaryLifecycle.generationRetirement",
    true,
  );
  const afterPrimaryReplacement = readyLaunch(
    primaryLifecycle.afterReplacement,
    c,
    "cell.phases.primaryLifecycle.afterReplacement",
  );
  nativeConfirmation(
    afterPrimaryReplacement.confirmation,
    "ALREADY_CONFIRMED",
    null,
    "cell.phases.primaryLifecycle.afterReplacement.confirmation",
  );
  if (
    afterPrimaryReplacement.identity.processId !==
      beforePrimaryRemoval.identity.processId ||
    afterPrimaryReplacement.identity.generationId ===
      beforePrimaryRemoval.identity.generationId ||
    beforePrimaryRemoval.contextIds.some((contextId) =>
      afterPrimaryReplacement.contextIds.includes(contextId),
    )
  ) {
    fail(
      "cell.phases.primaryLifecycle.afterReplacement",
      "must recreate a fresh primary and secondary in the same process",
    );
  }
  recovery(
    phases.fatalRecovery,
    "fatal",
    fatal,
    c,
    "cell.phases.fatalRecovery",
  );
  recovery(
    phases.unconfirmedRecovery,
    "unconfirmed",
    unconfirmed,
    c,
    "cell.phases.unconfirmedRecovery",
  );
  boolean(cell.passed, true, "cell.passed");
}

export function expectedLynxMatrixCellIds(
  platforms: readonly LynxMatrixPlatform[] = LYNX_MATRIX_PLATFORMS,
  frameworks: readonly LynxMatrixFramework[] = LYNX_MATRIX_FRAMEWORKS,
): string[] {
  return platforms.flatMap((platform) =>
    frameworks.map((framework) => `${framework}-${platform}`),
  );
}

export function validateLynxMatrixSummary(
  value: unknown,
  expectedCellIds = expectedLynxMatrixCellIds(),
): void {
  const summary = record(value, "summary");
  exactString(
    summary.schemaVersion,
    "lynx-public-matrix-summary-v1",
    "summary.schemaVersion",
  );
  const cells = summary.cells;
  if (!Array.isArray(cells)) fail("summary.cells", "expected an array");
  cells.forEach(validateLynxMatrixCell);
  const ids = cells.map((cell, index) =>
    string(
      record(cell, `summary.cells[${index}]`).cellId,
      `summary.cells[${index}].cellId`,
    ),
  );
  sameMembers(ids, expectedCellIds, "summary.cells");
  boolean(summary.passed, true, "summary.passed");
}
