import type { AppReadyResult } from "./clientPlugin";
import type { HotUpdaterError } from "./error";
import {
  getActiveUpdateState,
  getBundleId,
  getChannel,
  type LaunchTransition,
  type NotifyAppReadyResult,
  readNotifyAppReady,
} from "./native";
import {
  buildPluginEvent,
  dispatchPluginHook,
  emitPluginHook,
} from "./pluginHost";

export type NotifyAppReadyOptions = {
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};

type RequestAnimationFrame = (callback: (timestamp: number) => void) => number;

let didEmitAppReady = false;
/** Settles once this runtime's launch was read, whether it was reported or failed. */
let appReadyRead: Promise<unknown> | null = null;
/** Why the previous main process exited, read with this runtime's launch. */
let previousProcessExit: string | null = null;

/** Android 11+: why the app's previous main process exited, once the launch was read. */
export const getPreviousProcessExit = (): string | null => previousProcessExit;

const waitForNextFrame = () =>
  new Promise<void>((resolve) => {
    const requestAnimationFrame = (
      globalThis as typeof globalThis & {
        requestAnimationFrame?: RequestAnimationFrame;
      }
    )?.requestAnimationFrame;

    if (requestAnimationFrame) {
      requestAnimationFrame(() => resolve());
      return;
    }

    void Promise.resolve().then(resolve);
  });

/**
 * The Release the running bundle was selected as: the active or stable
 * selection that names it on the current channel.
 */
export const getRunningReleaseId = (
  bundleId: string,
  channel: string,
): string | null => {
  const state = getActiveUpdateState();
  return (
    [state.activeSelection, state.stableSelection].find(
      (selection) =>
        selection?.bundleId === bundleId && selection.channel === channel,
    )?.releaseId ?? null
  );
};

const toAppReadyResult = (
  result: NotifyAppReadyResult,
  transition: LaunchTransition | null,
): AppReadyResult | null => {
  const channel = getChannel();
  if (result.status === "UNCHANGED") {
    const bundleId = getBundleId();
    return {
      status: "UNCHANGED",
      channel,
      bundleId,
      releaseId: getRunningReleaseId(bundleId, channel),
      previousProcessExit,
    };
  }
  // Native persists the transition with every applied or recovered launch;
  // a report without it cannot say what moved.
  if (transition === null) return null;
  return {
    status: transition.type,
    channel,
    fromBundleId: transition.fromBundleId,
    fromReleaseId: transition.fromReleaseId,
    toBundleId: transition.toBundleId,
    toReleaseId: transition.toReleaseId,
    updateStrategy: transition.updateStrategy,
    previousProcessExit,
  };
};

const notifyAppReady = async (
  options: NotifyAppReadyOptions,
): Promise<NotifyAppReadyResult | undefined> => {
  try {
    let nativeReadResult: ReturnType<typeof readNotifyAppReady>;
    do {
      await waitForNextFrame();
      nativeReadResult = readNotifyAppReady();
    } while (nativeReadResult.pending);

    const { result, transition } = nativeReadResult;
    previousProcessExit = nativeReadResult.previousProcessExit;
    if (!didEmitAppReady) {
      didEmitAppReady = true;
      emitPluginHook("onAppReady", () => toAppReadyResult(result, transition));
    }

    options.onNotifyAppReady?.(result);
    return result;
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    options.onError?.(error);
    console.warn("[HotUpdater] Failed to notify app ready:", normalizedError);
    return undefined;
  }
};

/** Reads this runtime's launch once native finalizes it and reports it to plugins. */
export const handleNotifyAppReady = (
  options: NotifyAppReadyOptions,
): Promise<NotifyAppReadyResult | undefined> => {
  const readiness = notifyAppReady(options);
  appReadyRead ??= readiness;
  return readiness;
};

/**
 * Calls a plugin hook after this runtime's `onAppReady`, so plugins see the
 * launch before anything that followed it. The event is built now, from the
 * state it describes, and only when a plugin listens.
 */
export const emitAfterAppReady: typeof emitPluginHook = (
  name,
  createPayload,
) => {
  const payload = buildPluginEvent(name, createPayload);
  if (payload === null) return;
  if (appReadyRead === null) {
    dispatchPluginHook(name, payload);
    return;
  }
  void appReadyRead.then(() => dispatchPluginHook(name, payload));
};
