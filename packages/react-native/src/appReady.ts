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
import type { PluginHost } from "./pluginHost";

export type NotifyAppReadyOptions = {
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};

type RequestAnimationFrame = (callback: (timestamp: number) => void) => number;

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
  };
};

const notifyAppReady = async (
  host: PluginHost,
  options: NotifyAppReadyOptions,
): Promise<NotifyAppReadyResult | undefined> => {
  try {
    let nativeReadResult: ReturnType<typeof readNotifyAppReady>;
    do {
      await waitForNextFrame();
      nativeReadResult = readNotifyAppReady();
    } while (nativeReadResult.pending);

    const { result, transition } = nativeReadResult;
    host.emitPluginHook("onAppReady", () =>
      toAppReadyResult(result, transition),
    );

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

/** An instance's launch: read once, and reported to the instance's plugins. */
export interface LaunchReporter {
  /**
   * Reads this launch once native finalizes it and reports it to the
   * plugins, once. It rejects only if `onError` throws.
   */
  read(
    options: NotifyAppReadyOptions,
  ): Promise<NotifyAppReadyResult | undefined>;
  /** Settles once the launch was read, whether it was reported or failed. */
  readonly appReady: Promise<unknown>;
  /**
   * Calls a plugin hook after the instance's `onAppReady`, so plugins see the
   * launch before anything that followed it. The event is built now, from the
   * state it describes, and only when a plugin listens.
   */
  emit: PluginHost["emitPluginHook"];
}

export const createLaunchReporter = (host: PluginHost): LaunchReporter => {
  let launchRead: Promise<NotifyAppReadyResult | undefined> | null = null;
  return {
    read: (options) => {
      launchRead ??= notifyAppReady(host, options);
      return launchRead;
    },
    get appReady() {
      return launchRead ?? Promise.resolve();
    },
    emit: (name, createPayload) => {
      const payload = host.buildPluginEvent(name, createPayload);
      if (payload === null) return;
      if (launchRead === null) {
        host.dispatchPluginHook(name, payload);
        return;
      }
      void launchRead.then(() => host.dispatchPluginHook(name, payload));
    },
  };
};
