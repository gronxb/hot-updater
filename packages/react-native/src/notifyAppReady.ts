import type { HotUpdaterError } from "./error";
import { type NotifyAppReadyResult, readNotifyAppReady } from "./native";
import type { HotUpdaterResolver, ResolverNotifyAppReadyParams } from "./types";

export type NotifyAppReadyOptions = {
  resolver?: HotUpdaterResolver;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
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

const assertNever = (value: never): never => {
  throw new Error(`[HotUpdater] Unexpected notifyAppReady status: ${value}`);
};

const getResolverParams = (
  result: NotifyAppReadyResult,
  options: NotifyAppReadyOptions,
): ResolverNotifyAppReadyParams => {
  switch (result.status) {
    case "RECOVERED":
      return {
        crashedBundleId: result.fromBundleId,
        requestHeaders: options.requestHeaders,
        requestTimeout: options.requestTimeout,
        status: "RECOVERED",
      };
    case "UNCHANGED":
    case "UPDATE_APPLIED":
      return {
        requestHeaders: options.requestHeaders,
        requestTimeout: options.requestTimeout,
        status: "STABLE",
      };
    default:
      return assertNever(result);
  }
};

export const handleNotifyAppReady = async (
  options: NotifyAppReadyOptions,
): Promise<void> => {
  try {
    let nativeReadResult: ReturnType<typeof readNotifyAppReady>;
    do {
      await waitForNextFrame();
      nativeReadResult = readNotifyAppReady();
    } while (nativeReadResult.pending);

    const { result } = nativeReadResult;

    if (options.resolver?.notifyAppReady) {
      try {
        await options.resolver.notifyAppReady(
          getResolverParams(result, options),
        );
      } catch (error) {
        const warning =
          error instanceof Error ? error : new Error(String(error));
        options.onError?.(error);
        console.warn("[HotUpdater] Resolver notifyAppReady failed:", warning);
      }
    }

    options.onNotifyAppReady?.(result);
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    options.onError?.(error);
    console.warn("[HotUpdater] Failed to notify app ready:", normalizedError);
  }
};
