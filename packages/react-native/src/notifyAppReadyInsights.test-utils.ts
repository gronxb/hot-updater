import { vi } from "vitest";

import type {
  NotifyAppReadyInsightsEvent,
  NotifyAppReadyResult,
} from "./native";

export const createNotifyReadResult = (
  result: NotifyAppReadyResult = { status: "UNCHANGED" },
  insightsEvent: NotifyAppReadyInsightsEvent | null = null,
  pending = false,
): {
  insightsEvent: NotifyAppReadyInsightsEvent | null;
  pending: boolean;
  result: NotifyAppReadyResult;
} => ({
  insightsEvent,
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
