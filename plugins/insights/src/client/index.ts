import {
  defineClientPlugin,
  type AppReadyResult,
  type BundleDownloadedInfo,
  type HotUpdaterClientContext,
  type HotUpdaterClientPlugin,
  type UpdateCheckResult,
  type UpdateError,
  type UpdateHttpResponse,
} from "@hot-updater/protocol";

import { boundedText, readErrorDetails } from "./errorDetails";
import { createKeyedUUIDv7, createUUIDv7, timeOfUUIDv7 } from "./eventId";
import {
  createInsightsEventSender,
  type InsightsDelivery,
  type InsightsEventBody,
  type InsightsEventSender,
} from "./sender";
import {
  createInsightsState,
  type InsightsState,
  type QueuedEvent,
  utcDay,
  utcDayStart,
} from "./state";

export interface InsightsOptions {
  /**
   * Also report from debug builds (`__DEV__`). Defaults to `false`, so
   * development sessions stay out of production Insights.
   */
  readonly debug?: boolean;
}

/** The app's own id for the signed-in user, attached to later reports. */
export interface InsightsUser {
  readonly userId: string | number;
}

/** Insights on the instance `HotUpdater.init` returns, as `hotUpdater.insights`. */
export interface InsightsClient {
  /**
   * Attaches the signed-in user's id to later reports, or clears it with
   * `null`. It persists on the device and sends nothing by itself.
   */
  setUser(user: InsightsUser | null): void;
}

/** The `insights()` plugin: it adds `hotUpdater.insights`. */
export type InsightsPlugin = HotUpdaterClientPlugin<"insights", InsightsClient>;

type Movement = Pick<
  InsightsEventBody,
  | "type"
  | "channel"
  | "fromBundleId"
  | "fromReleaseId"
  | "toBundleId"
  | "toReleaseId"
  | "updateStrategy"
  | "metadata"
>;

/**
 * From this long, a report waited for a later launch or for React Native to
 * start, and says how old it is. Retries take about as long, and the reload
 * after a forced update far less, so those bodies stay as they were.
 */
const WAITED_MS = 60_000;

/**
 * How old a stored report can be and still try again after its attempts fail:
 * the Console's longest period. A device offline for that long still delivers
 * it on its next attempt, and a server that always fails can't keep it forever.
 */
const MAX_HANDED_OFF_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type PendingEvent = QueuedEvent & {
  /** For UPDATE_FAILED: a later success for its target made it moot. */
  superseded?: boolean;
  /** Stored for the next launch. An answer to a request in flight still counts. */
  handedOff?: boolean;
  /** It was already old when queued, so each attempt reports its age. */
  waited?: boolean;
};

const normalizeUserId = (user: InsightsUser | null): string | null => {
  if (user === null) return null;
  const userId = String(user.userId).trim();
  return userId.length === 0 ? null : userId;
};

/**
 * Reports update adoption to a server that runs the `insights()` server
 * plugin: launches (at most once a UTC day while nothing changes), downloads,
 * applies, recoveries, and update failures. After the server answers that
 * Insights is off, the plugin sends nothing for 24 hours, and for the rest
 * of that runtime.
 *
 * @example
 * ```ts
 * import { HotUpdater, insights } from "@hot-updater/react-native";
 *
 * export const hotUpdater = HotUpdater.init({ baseURL, plugins: [insights()] });
 * hotUpdater.insights.setUser({ userId: "user-123" });
 * ```
 */
export const insights = (options: InsightsOptions = {}): InsightsPlugin =>
  defineClientPlugin({
    id: "insights",
    setup: (pluginContext) => setUpInsights(options, pluginContext),
  });

/**
 * One instance's Insights: its context, device state, and delivery queue,
 * created by each `setup`, so a plugin object set up by two instances keeps
 * their reports apart.
 */
const setUpInsights = (
  options: InsightsOptions,
  pluginContext: HotUpdaterClientContext,
) => {
  let context: HotUpdaterClientContext | null = null;
  let state: InsightsState | null = null;
  /** A download in this runtime: a later no-change report would hide it. */
  let didDownload = false;
  let lastDownloadedSelection: string | null = null;
  /** The bundle the latest check of this runtime forces. */
  let forcedBundleId: string | null = null;
  const pending = new Map<InsightsEventBody, PendingEvent>();
  let send: InsightsEventSender | null = null;

  /**
   * `occurredAt` dates an event native code recorded before this runtime
   * started, such as a download a native `HotUpdaterInstance` finished.
   */
  const createEvent = (
    movement: Movement,
    eventId?: (now: number, installId: string) => string,
    occurredAt?: number,
  ): PendingEvent | null => {
    if (context === null || state === null) return null;
    const appVersion = context.appVersion;
    if (appVersion === null) {
      console.warn(
        `[HotUpdater] Insights needs the native app version; the ${movement.type} event was not sent.`,
      );
      return null;
    }
    const now = occurredAt ?? context.now();
    const installId = context.installId;
    const userId = state.readUserId();
    const response = state.readHttpResponse(movement.channel, appVersion);
    const body: InsightsEventBody = {
      ...movement,
      ...(response
        ? { metadata: { ...movement.metadata, httpResponse: response } }
        : {}),
      eventId: eventId?.(now, installId) ?? createUUIDv7(now),
      installId,
      ...(userId === null ? {} : { userId }),
      platform: context.platform,
      appVersion,
      cohort: context.getCohort(),
      fingerprintHash: context.getFingerprintHash(),
      sdkVersion: context.sdkVersion,
      minBundleId: context.minBundleId,
    };
    const day = utcDay(now);
    return {
      body,
      madeAtMs: now,
      day,
      report:
        movement.type === "UNCHANGED" ||
        movement.type === "UPDATE_APPLIED" ||
        movement.type === "RECOVERED"
          ? {
              day,
              channel: movement.channel,
              appVersion,
              bundleId: movement.toBundleId,
              releaseId: movement.toReleaseId,
              userId,
            }
          : null,
      failureKey: null,
    };
  };

  const enqueue = (event: PendingEvent | null) => {
    if (event === null || send === null || context === null) return;
    event.waited =
      event.madeAtMs !== undefined &&
      context.now() - event.madeAtMs >= WAITED_MS;
    const { type, toBundleId } = event.body;
    if (type === "UPDATE_DOWNLOADED" || type === "UPDATE_APPLIED") {
      // A failure for a target that then arrived no longer describes it.
      for (const queued of pending.values()) {
        if (
          queued.body.type === "UPDATE_FAILED" &&
          queued.body.toBundleId === toBundleId
        ) {
          queued.superseded = true;
        }
      }
    }
    pending.set(event.body, event);
    void send(event.body).catch((error: unknown) => {
      console.warn(
        `[HotUpdater] Insights ${event.body.type} event was not delivered:`,
        error,
      );
    });
  };

  const reportLaunch = (
    channel: string,
    bundleId: string,
    releaseId: string | null,
    fromReleaseId: string | null,
    occurredAt?: number,
  ) => {
    // After a download the server shows the update as waiting; a later
    // no-change report from this runtime would hide it.
    if (didDownload) return;
    enqueue(
      createEvent(
        {
          type: "UNCHANGED",
          channel,
          fromBundleId: null,
          fromReleaseId,
          toBundleId: bundleId,
          toReleaseId: releaseId,
          updateStrategy: null,
        },
        undefined,
        occurredAt,
      ),
    );
  };

  const onAppReady = (result: AppReadyResult) => {
    if (result.status === "UNCHANGED") {
      reportLaunch(result.channel, result.bundleId, result.releaseId, null);
      return;
    }
    enqueue(
      createEvent({
        type: result.status,
        channel: result.channel,
        fromBundleId: result.fromBundleId,
        fromReleaseId: result.fromReleaseId,
        toBundleId: result.toBundleId,
        toReleaseId: result.toReleaseId,
        updateStrategy: result.updateStrategy,
      }),
    );
  };

  const onUpdateCheck = (result: UpdateCheckResult) => {
    // `occurredAt` marks a check native made before this runtime started, which
    // this runtime does not reload for.
    if (result.occurredAt === undefined) {
      forcedBundleId =
        result.status === "UPDATE_AVAILABLE" && result.shouldForceUpdate
          ? result.toBundleId
          : null;
    }
    if (result.status !== "UNCHANGED") return;
    reportLaunch(
      result.channel,
      result.bundleId,
      result.releaseId,
      result.previousReleaseId === result.releaseId
        ? null
        : result.previousReleaseId,
      result.occurredAt,
    );
  };

  const onBundleDownloaded = (info: BundleDownloadedInfo) => {
    // The app normally reloads right after staging a forced bundle, and React
    // Native can abort when a request starts while a reload tears its modules
    // down. So what exists now waits for the next launch, and starts no request
    // here. Later reports send as usual, whether or not a reload comes.
    const forced =
      info.occurredAt === undefined && info.toBundleId === forcedBundleId;
    if (forced) {
      // The server stores an event once, so one in flight can be sent again.
      for (const event of pending.values()) {
        state?.handOffEvent(event);
        event.handedOff = true;
      }
    }
    const selection = JSON.stringify([
      info.channel,
      info.toReleaseId,
      info.toBundleId,
    ]);
    if (lastDownloadedSelection === selection) return;
    lastDownloadedSelection = selection;
    const event = createEvent(
      {
        type: "UPDATE_DOWNLOADED",
        channel: info.channel,
        fromBundleId: info.fromBundleId,
        fromReleaseId: info.fromReleaseId,
        toBundleId: info.toBundleId,
        toReleaseId: info.toReleaseId,
        updateStrategy: info.updateStrategy,
        metadata: {
          delivery: info.delivery,
          ...(info.patchFallback ? { patchFallback: true } : {}),
        },
      },
      undefined,
      info.occurredAt,
    );
    if (forced) {
      // The server has not heard of this download yet, so a later no-change
      // report hides nothing.
      if (event !== null) state?.handOffEvent(event);
      return;
    }
    didDownload = true;
    enqueue(event);
  };

  const onUpdateError = (error: UpdateError) => {
    // A check that could not reach the server means the device is offline,
    // and its report would not arrive either.
    if (error.stage === "check" && error.reason === "network") return;
    const targetBundleId = error.targetBundleId ?? error.bundleId;
    const details = readErrorDetails(error.cause);
    const failureKey = JSON.stringify([
      error.stage,
      error.reason,
      targetBundleId,
      details.errorMessage ?? null,
    ]);
    const event = createEvent(
      {
        type: "UPDATE_FAILED",
        channel: error.channel,
        fromBundleId: error.bundleId,
        fromReleaseId: error.releaseId,
        toBundleId: targetBundleId,
        toReleaseId: error.targetReleaseId ?? null,
        updateStrategy: error.updateStrategy,
        metadata: {
          failure: {
            stage: error.stage,
            reason: error.reason,
            ...details,
            ...(error.resource === undefined
              ? {}
              : { resource: error.resource }),
            ...(error.httpStatus === undefined
              ? {}
              : { httpStatus: error.httpStatus }),
            ...(error.transport === undefined
              ? {}
              : { transport: error.transport }),
            ...(error.originCode === undefined
              ? {}
              : { originCode: error.originCode }),
          },
        },
      },
      // One id per installation, UTC day, and failure, so the server
      // stores a repeated failure once.
      (now, installId) =>
        createKeyedUUIDv7(
          [installId, utcDay(now), failureKey].join("\n"),
          utcDayStart(now),
        ),
      error.occurredAt,
    );
    enqueue(event === null ? null : { ...event, failureKey });
  };

  const onHttpResponse = (response: UpdateHttpResponse) => {
    if (context === null || state === null || context.appVersion === null)
      return;
    const body =
      response.body === null ? null : boundedText(response.body, 4_096);
    // Observe locally. Only an existing lifecycle report can send this snapshot.
    // A replayed response keeps the channel its check targeted, which the
    // failure it explains reports.
    const channel = response.channel ?? context.getChannel();
    state.recordHttpResponse(channel, context.appVersion, {
      resource: response.resource,
      status: response.status,
      path: boundedText(response.path, 1_024),
      body,
      bodyTruncated: response.bodyTruncated || body !== response.body,
      receivedAtMs: response.occurredAt ?? context.now(),
    });
  };

  const admit = (body: InsightsEventBody): boolean => {
    const event = pending.get(body);
    if (event === undefined || state === null || context === null) {
      return false;
    }
    if (event.handedOff === true) {
      pending.delete(body);
      return false;
    }
    if (event.superseded === true || state.isPaused(context.now())) {
      pending.delete(body);
      state.forgetHandedOffEvent(body.eventId);
      return false;
    }
    const admitted =
      body.type === "UNCHANGED"
        ? event.report === null || !state.repeatsReport(event.report)
        : body.type === "UPDATE_FAILED"
          ? event.failureKey === null ||
            !state.hasFailure(event.day, event.failureKey)
          : true;
    if (!admitted) {
      pending.delete(body);
      state.forgetHandedOffEvent(body.eventId);
    }
    return admitted;
  };

  const ageOf = (body: InsightsEventBody) => {
    const event = pending.get(body);
    if (event?.waited !== true || context === null) return undefined;
    const age = context.now() - event.madeAtMs!;
    return age > 0 ? age : undefined;
  };

  const settle = (body: InsightsEventBody, delivery: InsightsDelivery) => {
    const event = pending.get(body);
    pending.delete(body);
    if (event === undefined || state === null || context === null) return;
    if (delivery === "failed") {
      // No answer said no, so a stored report tries again at the next launch.
      if (context.now() - timeOfUUIDv7(body.eventId) > MAX_HANDED_OFF_AGE_MS) {
        state.forgetHandedOffEvent(body.eventId);
      }
      return;
    }
    state.forgetHandedOffEvent(body.eventId);
    if (delivery === "rejected") return;
    if (delivery === "disabled") {
      state.pause(context.now());
      return;
    }
    if (event.failureKey !== null) {
      state.recordFailure(event.day, event.failureKey);
    }
    state.resume();
    if (event.report !== null) state.recordReport(event.report);
    else state.forgetReport();
  };

  context = pluginContext;
  const pluginState = createInsightsState(pluginContext.storage);
  state = pluginState;
  const api: InsightsClient = Object.freeze({
    setUser: (user: InsightsUser | null) => {
      pluginState.writeUserId(normalizeUserId(user));
    },
  });
  // A debug build keeps the user, but reports nothing.
  if (pluginContext.isDebugBuild && options.debug !== true) return { api };

  send = createInsightsEventSender(pluginContext.fetch, {
    admit,
    settle,
    ageOf,
  });
  // What an earlier runtime left goes first, ahead of what this one reports.
  for (const event of pluginState.readHandedOffEvents()) enqueue(event);
  return {
    api,
    hooks: {
      onAppReady,
      onUpdateCheck,
      onBundleDownloaded,
      onUpdateError,
      onHttpResponse,
    },
  };
};
