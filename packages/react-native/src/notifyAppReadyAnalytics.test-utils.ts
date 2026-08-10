import { vi } from "vitest";

import type {
  NotifyAppReadyAnalyticsEvent,
  NotifyAppReadyResult,
} from "./native";

export const createNotifyReadResult = (
  result: NotifyAppReadyResult = { status: "UNCHANGED" },
  analyticsEvent: NotifyAppReadyAnalyticsEvent | null = null,
  pending = false,
): {
  analyticsEvent: NotifyAppReadyAnalyticsEvent | null;
  pending: boolean;
  result: NotifyAppReadyResult;
} => ({
  analyticsEvent,
  pending,
  result,
});

export const stubNotifyFrame = () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: (timestamp: number) => void) => {
      setTimeout(() => callback(0), 0);
      return 1;
    }),
  );
};
