import {
  defineClientPlugin,
  type AppReadyResult,
  type BundleDownloadedInfo,
  type HotUpdaterClientContext,
  type HotUpdaterClientPlugin,
  type UpdateCheckResult,
  type UpdateError,
} from "@hot-updater/protocol";

import { readErrorDetails } from "./errorDetails";
import { createKeyedUUIDv7, createUUIDv7 } from "./eventId";
import {
  createInsightsEventSender,
  type InsightsDelivery,
  type InsightsEventBody,
  type InsightsEventSender,
} from "./sender";
import {
  createInsightsState,
  type InsightsState,
  type RunningReport,
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

export interface InsightsPlugin extends HotUpdaterClientPlugin {
  readonly id: "insights";
  /**
   * Attaches the signed-in user's id to later reports, or clears it with
   * `null`. It persists on the device, sends nothing by itself, and can be
   * called before `HotUpdater.init`.
   */
  setUser(user: InsightsUser | null): void;
}

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

/** A report the plugin built, with what the gate needs to decide on it. */
type PendingEvent = {
  readonly body: InsightsEventBody;
  readonly day: string;
  /** For UNCHANGED, UPDATE_APPLIED and RECOVERED: what the report says runs. */
  readonly report: RunningReport | null;
  /** For UPDATE_FAILED: the day's key the failure is reported under. */
  readonly failureKey: string | null;
  /** For UPDATE_FAILED: a later success for its target made it moot. */
  superseded?: boolean;
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
 * const analytics = insights();
 * HotUpdater.init({ baseURL, plugins: [analytics] });
 * analytics.setUser({ userId: "user-123" });
 * ```
 */
export const insights = (options: InsightsOptions = {}): InsightsPlugin => {
  let context: HotUpdaterClientContext | null = null;
  let state: InsightsState | null = null;
  /** A user set before setup, applied once the plugin has storage. */
  let pendingUser: { readonly userId: string | null } | null = null;
  /** A download in this runtime: a later no-change report would hide it. */
  let didDownload = false;
  let lastDownloadedSelection: string | null = null;
  const pending = new Map<InsightsEventBody, PendingEvent>();
  let send: InsightsEventSender | null = null;

  const createEvent = (
    movement: Movement,
    eventId?: (now: number, installId: string) => string,
  ): PendingEvent | null => {
    if (context === null || state === null) return null;
    const appVersion = context.appVersion;
    if (appVersion === null) {
      console.warn(
        `[HotUpdater] Insights needs the native app version; the ${movement.type} event was not sent.`,
      );
      return null;
    }
    const now = context.now();
    const installId = context.installId;
    const userId = state.readUserId();
    const body: InsightsEventBody = {
      ...movement,
      eventId: eventId?.(now, installId) ?? createUUIDv7(),
      installId,
      ...(userId === null ? {} : { userId }),
      platform: context.platform,
      appVersion,
      cohort: context.getCohort(),
      fingerprintHash: context.getFingerprintHash(),
      sdkVersion: context.sdkVersion,
    };
    const day = utcDay(now);
    return {
      body,
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
    if (event === null || send === null) return;
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
  ) => {
    // After a download the server shows the update as waiting; a later
    // no-change report from this runtime would hide it.
    if (didDownload) return;
    enqueue(
      createEvent({
        type: "UNCHANGED",
        channel,
        fromBundleId: null,
        fromReleaseId,
        toBundleId: bundleId,
        toReleaseId: releaseId,
        updateStrategy: null,
      }),
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
        // Tells a crash from the system or the user closing the app.
        ...(result.status === "RECOVERED" && result.previousProcessExit !== null
          ? { metadata: { previousProcessExit: result.previousProcessExit } }
          : {}),
      }),
    );
  };

  const onUpdateCheck = (result: UpdateCheckResult) => {
    if (result.status !== "UNCHANGED") return;
    reportLaunch(
      result.channel,
      result.bundleId,
      result.releaseId,
      result.previousReleaseId === result.releaseId
        ? null
        : result.previousReleaseId,
    );
  };

  const onBundleDownloaded = (info: BundleDownloadedInfo) => {
    const selection = JSON.stringify([
      info.channel,
      info.toReleaseId,
      info.toBundleId,
    ]);
    if (lastDownloadedSelection === selection) return;
    lastDownloadedSelection = selection;
    didDownload = true;
    enqueue(
      createEvent({
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
      }),
    );
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
            ...(error.previousProcessExit === undefined
              ? {}
              : { previousProcessExit: error.previousProcessExit }),
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
    );
    enqueue(event === null ? null : { ...event, failureKey });
  };

  const admit = (body: InsightsEventBody): boolean => {
    const event = pending.get(body);
    if (event === undefined || state === null || context === null) {
      return false;
    }
    if (event.superseded === true || state.isPaused(context.now())) {
      pending.delete(body);
      return false;
    }
    const admitted =
      body.type === "UNCHANGED"
        ? event.report === null || !state.repeatsReport(event.report)
        : body.type === "UPDATE_FAILED"
          ? event.failureKey === null ||
            !state.hasFailure(event.day, event.failureKey)
          : true;
    if (!admitted) pending.delete(body);
    return admitted;
  };

  const settle = (body: InsightsEventBody, delivery: InsightsDelivery) => {
    const event = pending.get(body);
    pending.delete(body);
    if (event === undefined || state === null || context === null) return;
    if (delivery === "failed") return;
    if (delivery === "disabled") {
      state.pause(context.now());
      return;
    }
    if (event.failureKey !== null) {
      state.recordFailure(event.day, event.failureKey);
    }
    if (delivery === "refused") return;
    state.resume();
    if (event.report !== null) state.recordReport(event.report);
    else state.forgetReport();
  };

  return defineClientPlugin({
    id: "insights",
    setup(pluginContext) {
      context = pluginContext;
      state = createInsightsState(pluginContext.storage);
      if (pendingUser !== null) {
        state.writeUserId(pendingUser.userId);
        pendingUser = null;
      }
      if (pluginContext.isDebugBuild && options.debug !== true) return;

      send = createInsightsEventSender(pluginContext.fetch, { admit, settle });
      return { onAppReady, onUpdateCheck, onBundleDownloaded, onUpdateError };
    },
    setUser(user) {
      const userId = normalizeUserId(user);
      if (state === null) {
        pendingUser = { userId };
        return;
      }
      state.writeUserId(userId);
    },
  });
};
