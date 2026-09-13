import {
  INVALID_COHORT_ERROR_MESSAGE,
  isValidCohort,
  normalizeCohortValue,
} from "@hot-updater/core";

import { checkForUpdate } from "./checkForUpdate";
import { callNative, LynxUpdaterError, normalizeNativeState } from "./native";
import type {
  ActiveUpdateSelection,
  ActiveUpdateState,
  CheckForUpdateOptions,
  ConfirmationResult,
  CustomReloadHandler,
  HotUpdaterInitOptions,
  HotUpdaterOptions,
  LaunchInfo,
  LaunchTransitionReceipt,
  NativeState,
  NotifyAppReadyResult,
  SelectionSummary,
} from "./types";

const missingInit = (methodName: string) =>
  new Error(
    `[HotUpdater] ${methodName} requires HotUpdater.init() to be used.\n\n` +
      `  HotUpdater.init({\n` +
      `    baseURL: "<your-update-server-url>",\n` +
      `  });\n`,
  );

const summary = (selection: SelectionSummary): SelectionSummary => ({
  kind: selection.kind,
  bundleId: selection.bundleId,
  releaseId: selection.releaseId,
  channel: selection.channel,
});

const publicSelection = (
  selection: NativeState["runningSelection"] | null,
): ActiveUpdateSelection | null =>
  selection === null
    ? null
    : {
        kind: selection.kind,
        releaseId: selection.releaseId,
        bundleId: selection.bundleId,
        channel: selection.channel,
      };

const isSelectionSummary = (value: unknown): value is SelectionSummary => {
  if (value === null || typeof value !== "object") return false;
  const selection = value as Partial<SelectionSummary>;
  return (
    (selection.kind === "BUNDLE" ||
      selection.kind === "EMBEDDED" ||
      selection.kind === "BUILTIN") &&
    typeof selection.bundleId === "string" &&
    selection.bundleId.length > 0 &&
    (selection.releaseId === null ||
      (typeof selection.releaseId === "string" &&
        selection.releaseId.length > 0)) &&
    typeof selection.channel === "string" &&
    selection.channel.length > 0
  );
};

const sameSelectionIdentity = (
  left: SelectionSummary,
  right: SelectionSummary,
) => left.bundleId === right.bundleId && left.releaseId === right.releaseId;

const sameSelection = (left: SelectionSummary, right: SelectionSummary) =>
  sameSelectionIdentity(left, right) &&
  left.kind === right.kind &&
  left.channel === right.channel;

const isLaunchTransition = (
  value: unknown,
  running: SelectionSummary,
): value is LaunchTransitionReceipt => {
  if (value === null || typeof value !== "object") return false;
  const transition = value as Partial<LaunchTransitionReceipt>;
  if (
    (transition.kind !== "UPDATE_APPLIED" &&
      transition.kind !== "RECOVERED" &&
      transition.kind !== "UNCHANGED") ||
    !isSelectionSummary(transition.from) ||
    !isSelectionSummary(transition.to) ||
    !sameSelection(transition.to, running)
  ) {
    return false;
  }
  if (transition.kind === "UNCHANGED") {
    return (
      transition.from.bundleId === transition.to.bundleId &&
      typeof transition.from.releaseId === "string" &&
      typeof transition.to.releaseId === "string" &&
      transition.from.releaseId !== transition.to.releaseId
    );
  }
  if (transition.kind === "UPDATE_APPLIED") {
    return transition.from.bundleId !== transition.to.bundleId;
  }
  return !sameSelectionIdentity(transition.from, transition.to);
};

function createHotUpdaterClient() {
  const config: {
    client: HotUpdaterOptions | null;
    onError?: (error: Error) => void;
  } = {
    client: null,
  };
  let snapshot: NativeState | null = null;
  let customReload: CustomReloadHandler | null = null;

  const ensureClient = (methodName: string): HotUpdaterOptions => {
    if (!config.client) throw missingInit(methodName);
    return config.client;
  };

  const refreshState = async () => {
    const next = await callNative<NativeState>("getState");
    snapshot = normalizeNativeState(next);
    return snapshot;
  };

  const requireSnapshot = <T>(read: (state: NativeState) => T): T => {
    if (!snapshot) {
      throw new LynxUpdaterError(
        "NATIVE_STATE_UNAVAILABLE",
        "Call HotUpdater.notifyAppReady() or HotUpdater.checkForUpdate() before reading native state.",
      );
    }
    return read(snapshot);
  };

  return {
    init: (options: HotUpdaterInitOptions): void => {
      config.onError = options.onError;
      config.client = {
        baseURL: options.baseURL,
        requestHeaders: options.requestHeaders
          ? { ...options.requestHeaders }
          : undefined,
        requestTimeout: options.requestTimeout,
      };
    },

    async checkForUpdate(options: CheckForUpdateOptions) {
      const client = ensureClient("checkForUpdate");
      try {
        const result = await checkForUpdate({
          ...options,
          client,
          requestHeaders: {
            ...client.requestHeaders,
            ...options.requestHeaders,
          },
          requestTimeout: options.requestTimeout ?? client.requestTimeout,
          onError: options.onError ?? config.onError,
        });
        await refreshState();
        if (!result) return null;
        return {
          ...result,
          updateBundle: async () => {
            const ok = await result.updateBundle();
            await refreshState();
            return ok;
          },
        };
      } catch (error) {
        (options.onError ?? config.onError)?.(error as Error);
        throw error;
      }
    },

    async notifyAppReady(): Promise<NotifyAppReadyResult> {
      await refreshState();
      const confirmation =
        await callNative<ConfirmationResult>("notifyAppReady");
      const after = await refreshState();
      const transition = confirmation?.transition;
      if (
        (confirmation?.status !== "CONFIRMED" &&
          confirmation?.status !== "ALREADY_CONFIRMED") ||
        !("transition" in confirmation) ||
        (transition !== null &&
          !isLaunchTransition(transition, after.runningSelection))
      ) {
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native readiness returned an invalid launch transition receipt.",
        );
      }
      if (transition === null) return { status: "UNCHANGED" };
      if (transition.kind === "UNCHANGED") {
        return {
          status: "UNCHANGED",
          fromReleaseId: transition.from.releaseId!,
          toReleaseId: transition.to.releaseId!,
        };
      }
      return {
        status: transition.kind,
        fromBundleId: transition.from.bundleId,
        toBundleId: transition.to.bundleId,
        ...(transition.from.releaseId === null
          ? {}
          : { fromReleaseId: transition.from.releaseId }),
        ...(transition.to.releaseId === null
          ? {}
          : { toReleaseId: transition.to.releaseId }),
      };
    },

    async getLaunchInfo(): Promise<LaunchInfo> {
      const state = await refreshState();
      return {
        platform: state.platform,
        runtimeId: state.runtimeId,
        running: summary(state.runningSelection),
        confirmed: state.runningConfirmed,
        next: state.nextSelection ? summary(state.nextSelection) : null,
      };
    },

    async reload() {
      if (customReload !== null) {
        await customReload();
        return;
      }
      await callNative("reload");
    },

    setReloadBehavior(behavior: "custom", handler: CustomReloadHandler) {
      if (behavior !== "custom" || typeof handler !== "function") {
        throw new LynxUpdaterError(
          "INVALID_CONFIG",
          'HotUpdater.setReloadBehavior("custom") requires a reload handler.',
        );
      }
      customReload = handler;
    },

    isUpdateDownloaded: () =>
      requireSnapshot((state) => state.nextSelection !== null),

    getAppVersion: () => requireSnapshot((state) => state.appVersion),
    getActiveUpdateState: (): ActiveUpdateState =>
      requireSnapshot((state) => ({
        activeSelection: publicSelection(
          state.nextSelection ?? state.runningSelection,
        ),
        stableSelection: publicSelection(state.confirmedSelection),
        verificationPending: !state.runningConfirmed,
      })),
    getBundleId: () =>
      requireSnapshot(
        (state) =>
          state.runningSelection.releaseId ?? state.runningSelection.bundleId,
      ),
    getMinBundleId: () => requireSnapshot((state) => state.minimumBundleId),
    getChannel: () => requireSnapshot((state) => state.channel),
    getDefaultChannel: () =>
      requireSnapshot((state) => state.defaultChannel ?? state.channel),
    isChannelSwitched: () =>
      requireSnapshot(
        (state) => state.channel !== (state.defaultChannel ?? state.channel),
      ),
    setCohort: (cohort: string) => {
      const normalized = normalizeCohortValue(cohort);
      if (!isValidCohort(normalized)) {
        throw new LynxUpdaterError(
          "INVALID_COHORT",
          INVALID_COHORT_ERROR_MESSAGE,
        );
      }
      return callNative<NativeState>("setCohort", {
        cohort: normalized,
      }).then((state) => {
        snapshot = normalizeNativeState(state);
      });
    },
    getCohort: () => requireSnapshot((state) => state.cohort),
    async updateBundle() {
      throw new LynxUpdaterError(
        "USE_CHECK_FOR_UPDATE",
        "Call checkForUpdate() and then update.updateBundle().",
      );
    },
    async resetChannel() {
      try {
        const result = await callNative<{ reset: boolean }>("resetChannel");
        return result.reset;
      } finally {
        snapshot = null;
      }
    },
    getFingerprintHash: () =>
      requireSnapshot((state) => state.fingerprintHash ?? null),
    getCrashHistory: () =>
      requireSnapshot((state) => [...state.crashedBundleIds]),
    clearCrashHistory: async () => {
      await callNative("clearCrashHistory");
      await refreshState();
    },
  };
}

export const HotUpdater = createHotUpdaterClient();
