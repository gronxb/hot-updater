import { vi } from "vitest";

import type { LaunchTransition, NotifyAppReadyResult } from "./native";

export const createNotifyReadResult = (
  result: NotifyAppReadyResult = { status: "UNCHANGED" },
  transition: LaunchTransition | null = null,
  pending = false,
): {
  transition: LaunchTransition | null;
  pending: boolean;
  result: NotifyAppReadyResult;
} => ({
  transition,
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
