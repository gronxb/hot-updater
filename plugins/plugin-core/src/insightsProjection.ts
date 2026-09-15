import type {
  BundleEventRow,
  InsightsRecordEventInput,
  InsightsModel,
  ReleaseReference,
} from "./types/internal";

export interface InsightsLifetimeKey {
  readonly release: ReleaseReference;
  readonly installId: string;
  readonly metric: "downloaded" | "recovered";
}

export interface InsightsCurrentDelta {
  readonly release: ReleaseReference;
  readonly metric: "active" | "pending";
  readonly delta: -1 | 1;
}

export interface PreparedInsightsEvent {
  readonly event: BundleEventRow;
  readonly expectedRevision: string;
  readonly nextState: string;
  readonly currentDeltas: readonly InsightsCurrentDelta[];
  readonly firstLifetime: InsightsLifetimeKey | null;
  readonly hourly: {
    readonly release: ReleaseReference;
    readonly hourStartMs: number;
    readonly metric: "downloaded" | "applied" | "recovered";
  } | null;
}

export interface InsightsRecordContext {
  readonly revision: string;
  readonly state: string | null;
  readonly lifetimeExists: boolean;
}

export interface InsightsProjectionBackend {
  readRecordContext(input: {
    readonly installId: string;
    readonly lifetimeKey: InsightsLifetimeKey | null;
  }): Promise<InsightsRecordContext>;
  commitPreparedEvent(
    input: PreparedInsightsEvent,
  ): Promise<
    | { readonly status: "committed" }
    | { readonly status: "duplicate" }
    | { readonly status: "conflict" }
  >;
  getReleaseActivity: InsightsModel["getReleaseActivity"];
}

type ReceiptTuple = {
  readonly receivedAtMs: number;
  readonly id: string;
};

type RunningKey = {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly bundleId: string;
};

type ReleaseAssignment = {
  readonly tuple: ReceiptTuple;
  readonly releaseId: string | null;
};

type ProjectionState = {
  readonly version: 1;
  readonly head: {
    readonly tuple: ReceiptTuple;
    readonly key: RunningKey;
    readonly pending: ReleaseReference | null;
  };
  readonly anchor: ReleaseAssignment | null;
  readonly barrier: ReceiptTuple | null;
};

const RECORD_ATTEMPTS = 32;

export const insightsReleaseKey = (release: ReleaseReference): string =>
  JSON.stringify([release.platform, release.channel, release.releaseId]);

export const insightsLifetimeMarkerKey = (key: InsightsLifetimeKey): string =>
  JSON.stringify([
    key.release.platform,
    key.release.channel,
    key.release.releaseId,
    key.installId,
    key.metric,
  ]);

export const insightsHourlyBucketKey = (
  release: ReleaseReference,
  hourStartMs: number,
): string =>
  JSON.stringify([
    release.platform,
    release.channel,
    release.releaseId,
    hourStartMs,
  ]);

const compareTuple = (left: ReceiptTuple, right: ReceiptTuple): number =>
  left.receivedAtMs - right.receivedAtMs ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const sameKey = (left: RunningKey, right: RunningKey): boolean =>
  left.platform === right.platform &&
  left.channel === right.channel &&
  left.bundleId === right.bundleId;

const sameRelease = (
  left: ReleaseReference | null,
  right: ReleaseReference | null,
): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.releaseId === right.releaseId &&
    left.platform === right.platform &&
    left.channel === right.channel);

const release = (
  event: BundleEventRow,
  releaseId: string | null,
): ReleaseReference | null =>
  releaseId === null
    ? null
    : {
        releaseId,
        platform: event.platform,
        channel: event.channel,
      };

const tuple = (event: BundleEventRow): ReceiptTuple => ({
  receivedAtMs: event.received_at_ms,
  id: event.id,
});

const runningKey = (event: BundleEventRow): RunningKey => ({
  platform: event.platform,
  channel: event.channel,
  bundleId:
    event.type === "UPDATE_DOWNLOADED"
      ? event.from_bundle_id
      : event.to_bundle_id,
});

const assignment = (event: BundleEventRow): ReleaseAssignment | null => {
  const releaseId =
    event.type === "UPDATE_DOWNLOADED"
      ? event.from_release_id
      : event.to_release_id;
  if (
    releaseId === null &&
    (event.type === "UNCHANGED" || event.type === "UPDATE_DOWNLOADED")
  ) {
    return null;
  }
  return { tuple: tuple(event), releaseId };
};

const pending = (event: BundleEventRow): ReleaseReference | null =>
  event.type === "UPDATE_DOWNLOADED"
    ? release(event, event.to_release_id)
    : null;

const active = (state: ProjectionState | null): ReleaseReference | null => {
  if (
    state === null ||
    state.anchor === null ||
    state.anchor.releaseId === null ||
    (state.barrier !== null &&
      compareTuple(state.anchor.tuple, state.barrier) <= 0)
  ) {
    return null;
  }
  return {
    releaseId: state.anchor.releaseId,
    platform: state.head.key.platform,
    channel: state.head.key.channel,
  };
};

const currentDeltas = (
  previous: ProjectionState | null,
  next: ProjectionState,
): readonly InsightsCurrentDelta[] => {
  const deltas: InsightsCurrentDelta[] = [];
  const append = (
    metric: InsightsCurrentDelta["metric"],
    before: ReleaseReference | null,
    after: ReleaseReference | null,
  ) => {
    if (sameRelease(before, after)) return;
    if (before !== null) deltas.push({ release: before, metric, delta: -1 });
    if (after !== null) deltas.push({ release: after, metric, delta: 1 });
  };
  append("active", active(previous), active(next));
  append("pending", previous?.head.pending ?? null, next.head.pending);
  return deltas;
};

export const reduceInsightsProjection = (
  previous: ProjectionState | null,
  event: BundleEventRow,
): ProjectionState => {
  const eventTuple = tuple(event);
  const eventKey = runningKey(event);
  const eventAssignment = assignment(event);
  if (previous === null) {
    return {
      version: 1,
      head: { tuple: eventTuple, key: eventKey, pending: pending(event) },
      anchor: eventAssignment,
      barrier: null,
    };
  }

  if (compareTuple(eventTuple, previous.head.tuple) > 0) {
    if (sameKey(eventKey, previous.head.key)) {
      return {
        ...previous,
        head: { tuple: eventTuple, key: eventKey, pending: pending(event) },
        anchor: eventAssignment !== null ? eventAssignment : previous.anchor,
      };
    }
    return {
      version: 1,
      head: { tuple: eventTuple, key: eventKey, pending: pending(event) },
      anchor: eventAssignment,
      barrier: previous.head.tuple,
    };
  }

  if (sameKey(eventKey, previous.head.key)) {
    const afterBarrier =
      previous.barrier === null ||
      compareTuple(eventTuple, previous.barrier) > 0;
    const advancesAnchor =
      eventAssignment !== null &&
      (previous.anchor === null ||
        compareTuple(eventTuple, previous.anchor.tuple) > 0);
    return afterBarrier && advancesAnchor
      ? { ...previous, anchor: eventAssignment }
      : previous;
  }

  return previous.barrier === null ||
    compareTuple(eventTuple, previous.barrier) > 0
    ? { ...previous, barrier: eventTuple }
    : previous;
};

const parseState = (value: string | null): ProjectionState | null => {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1
  ) {
    throw new Error("Unsupported Insights projection state");
  }
  return parsed as ProjectionState;
};

const lifetimeKey = (event: BundleEventRow): InsightsLifetimeKey | null => {
  if (event.type === "UPDATE_DOWNLOADED") {
    const target = release(event, event.to_release_id);
    return target === null
      ? null
      : { release: target, installId: event.install_id, metric: "downloaded" };
  }
  if (event.type === "RECOVERED") {
    const source = release(event, event.from_release_id);
    return source === null
      ? null
      : { release: source, installId: event.install_id, metric: "recovered" };
  }
  return null;
};

const hourly = (event: BundleEventRow): PreparedInsightsEvent["hourly"] => {
  const metric =
    event.type === "UPDATE_DOWNLOADED"
      ? "downloaded"
      : event.type === "UPDATE_APPLIED"
        ? "applied"
        : event.type === "RECOVERED"
          ? "recovered"
          : null;
  if (metric === null) return null;
  const target = release(
    event,
    event.type === "RECOVERED" ? event.from_release_id : event.to_release_id,
  );
  return target === null
    ? null
    : {
        release: target,
        hourStartMs: Math.floor(event.received_at_ms / 3_600_000) * 3_600_000,
        metric,
      };
};

export const prepareInsightsEvent = (
  input: InsightsRecordEventInput,
  context: {
    readonly revision: string;
    readonly state: string | null;
    readonly lifetimeExists: boolean;
  },
): PreparedInsightsEvent => {
  const previous = parseState(context.state);
  const next = reduceInsightsProjection(previous, input.event);
  const key = lifetimeKey(input.event);
  return {
    event: input.event,
    expectedRevision: context.revision,
    nextState: JSON.stringify(next),
    currentDeltas: currentDeltas(previous, next),
    firstLifetime: key !== null && !context.lifetimeExists ? key : null,
    hourly: hourly(input.event),
  };
};

export const recordProjectedInsightsEvent = async (
  storage: InsightsProjectionBackend,
  input: InsightsRecordEventInput,
): Promise<void> => {
  const key = lifetimeKey(input.event);
  for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt += 1) {
    const context = await storage.readRecordContext({
      installId: input.event.install_id,
      lifetimeKey: key,
    });
    const result = await storage.commitPreparedEvent(
      prepareInsightsEvent(input, context),
    );
    if (result.status === "committed" || result.status === "duplicate") return;
    if (attempt + 1 < RECORD_ATTEMPTS) {
      // Spread competing writers before reading another revision.
      const delayMs = Math.random() * Math.min(10 * 2 ** attempt, 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Insights projection write conflicted too many times");
};
