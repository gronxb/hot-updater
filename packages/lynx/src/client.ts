import { checkForUpdate } from "./checkForUpdate";
import { callNative, LynxUpdaterError } from "./native";
import type {
  ActiveUpdateSelection,
  ActiveUpdateState,
  CheckForUpdateOptions,
  ConfirmationResult,
  CustomReloadHandler,
  HotUpdaterEvent,
  HotUpdaterInitOptions,
  HotUpdaterOptions,
  LaunchInfo,
  Manifest,
  NativeState,
  NotifyAppReadyResult,
  ReloadBehaviorSetting,
  SelectionSummary,
  SetUserParams,
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

function createHotUpdaterClient() {
  const config: {
    client: HotUpdaterOptions | null;
    insights: boolean;
    onError?: (error: Error) => void;
  } = {
    client: null,
    insights: true,
  };
  let snapshot: NativeState | null = null;
  let updateDownloaded = false;
  let reloadBehavior: ReloadBehaviorSetting = "processRestart";
  let customReload: CustomReloadHandler | null = null;
  const listeners = new Map<
    keyof HotUpdaterEvent,
    Set<(event: HotUpdaterEvent[keyof HotUpdaterEvent]) => void>
  >();

  const ensureClient = (methodName: string): HotUpdaterOptions => {
    if (!config.client) throw missingInit(methodName);
    return config.client;
  };

  const asStringList = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { length?: unknown }).length === "number"
    ) {
      const length = (value as { length: number }).length;
      const items: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = (value as Record<number, unknown>)[index];
        if (typeof item === "string") {
          items.push(item);
        }
      }
      return items;
    }
    return [];
  };

  const refreshState = async () => {
    const next = await callNative<NativeState>("getState");
    snapshot = {
      ...next,
      crashedBundleIds: asStringList(next.crashedBundleIds),
      unconfirmedReleaseIds: asStringList(next.unconfirmedReleaseIds),
    };
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
      config.insights = options.insights ?? true;
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
            updateDownloaded = ok;
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
      const before = await refreshState();
      const confirmation =
        await callNative<ConfirmationResult>("notifyAppReady");
      const after = await refreshState();
      const crashedIds = before.crashedBundleIds;
      const crashedBundleId = crashedIds[crashedIds.length - 1];
      if (
        crashedBundleId &&
        after.runningSelection.bundleId !== crashedBundleId
      ) {
        return {
          status: "RECOVERED",
          fromBundleId: crashedBundleId,
          toBundleId: after.runningSelection.bundleId,
          toReleaseId: after.runningSelection.releaseId ?? undefined,
        };
      }
      if (confirmation.status === "ALREADY_CONFIRMED") {
        return { status: "UNCHANGED" };
      }
      if (
        after.runningSelection.kind === "BUNDLE" &&
        after.runningSelection.bundleId !== before.embeddedBundleId
      ) {
        return {
          status: "UPDATE_APPLIED",
          fromBundleId: before.runningSelection.bundleId,
          toBundleId: after.runningSelection.bundleId,
          fromReleaseId: before.runningSelection.releaseId ?? undefined,
          toReleaseId: after.runningSelection.releaseId ?? undefined,
        };
      }
      return { status: "UNCHANGED" };
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
      if (reloadBehavior === "custom") {
        await customReload?.();
        return;
      }
      try {
        await callNative("reload");
      } catch (error) {
        if (
          error instanceof LynxUpdaterError &&
          error.code === "NATIVE_MODULE_UNAVAILABLE"
        ) {
          return;
        }
        throw error;
      }
    },

    setReloadBehavior(
      behavior: ReloadBehaviorSetting,
      handler?: CustomReloadHandler,
    ) {
      reloadBehavior = behavior;
      customReload = behavior === "custom" ? (handler ?? null) : null;
    },

    isUpdateDownloaded: () => updateDownloaded,

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
          (state.nextSelection ?? state.runningSelection).releaseId ??
          (state.nextSelection ?? state.runningSelection).bundleId,
      ),
    getMinBundleId: () => requireSnapshot((state) => state.minimumBundleId),
    getManifest: (): Manifest =>
      requireSnapshot((state) => ({
        bundleId: state.runningSelection.bundleId,
        assets: {},
      })),
    getChannel: () => requireSnapshot((state) => state.channel),
    getDefaultChannel: () =>
      requireSnapshot((state) => state.defaultChannel ?? state.channel),
    isChannelSwitched: () =>
      requireSnapshot(
        (state) => state.channel !== (state.defaultChannel ?? state.channel),
      ),
    setCohort: (cohort: string) =>
      callNative<NativeState>("setCohort", { cohort }).then((state) => {
        snapshot = state;
      }),
    getCohort: () => requireSnapshot((state) => state.cohort),
    addListener: <T extends keyof HotUpdaterEvent>(
      eventName: T,
      listener: (event: HotUpdaterEvent[T]) => void,
    ) => {
      const bucket =
        listeners.get(eventName) ??
        new Set<(event: HotUpdaterEvent[keyof HotUpdaterEvent]) => void>();
      bucket.add(
        listener as (event: HotUpdaterEvent[keyof HotUpdaterEvent]) => void,
      );
      listeners.set(eventName, bucket);
      return () => {
        bucket.delete(
          listener as (event: HotUpdaterEvent[keyof HotUpdaterEvent]) => void,
        );
      };
    },
    async updateBundle() {
      throw new LynxUpdaterError(
        "USE_CHECK_FOR_UPDATE",
        "Call checkForUpdate() and then update.updateBundle().",
      );
    },
    async resetChannel() {
      const result = await callNative<{ reset: boolean }>("resetChannel");
      await refreshState();
      return result.reset;
    },
    getFingerprintHash: () =>
      requireSnapshot((state) => state.fingerprintHash ?? null),
    getInstallId: () =>
      requireSnapshot((state) => state.runningSelection.bundleId),
    setUser: (_params: SetUserParams | null) => {
      throw new LynxUpdaterError(
        "NATIVE_MODULE_UNAVAILABLE",
        "HotUpdater.setUser is not available on Lynx yet.",
      );
    },
    getCrashHistory: () =>
      requireSnapshot((state) => [...state.crashedBundleIds]),
    clearCrashHistory: () => {
      void callNative("clearCrashHistory").then(refreshState);
    },
  };
}

export const HotUpdater = createHotUpdaterClient();
