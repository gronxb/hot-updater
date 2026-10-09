import { createAgentDeviceClient } from "agent-device";
import type { AgentDeviceDaemonTransport } from "agent-device";
import { describe, expect, it, vi } from "vitest";

import { createIosAlertReader } from "./ios-alert.ts";

function fixture() {
  const controller = new AbortController();
  const transport = vi.fn<AgentDeviceDaemonTransport>();
  const client = createAgentDeviceClient(
    { session: "owned-run-0" },
    { transport },
  );
  const reader = createIosAlertReader(
    { session: "owned-run", deviceId: "leased-udid" },
    controller.signal,
    client,
  );
  return { reader, transport, controller };
}

describe("native iOS alert reader", () => {
  it("uses the installed public client with the pinned session and device without opening the app", async () => {
    const f = fixture();
    f.transport.mockResolvedValue({
      ok: true,
      data: {
        message: "‘HotUpdaterExample’에서 열겠습니까?",
        items: ["취소", "열기"],
      },
    });
    await expect(f.reader.get()).resolves.toEqual({
      title: "‘HotUpdaterExample’에서 열겠습니까?",
      buttons: ["취소", "열기"],
    });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0]![0]).toMatchObject({
      command: "alert",
      session: "owned-run-0",
      positionals: ["get"],
      flags: { platform: "ios", udid: "leased-udid" },
    });
  });

  it.each([
    { runnerErrorCode: "ALERT_NOT_FOUND" },
    { reason: "alert-not-found" },
  ])(
    "handles the pinned native absent-alert error details: %j",
    async (details) => {
      const f = fixture();
      f.transport.mockResolvedValue({
        ok: false,
        error: { code: "COMMAND_FAILED", message: "alert not found", details },
      });
      await expect(f.reader.get()).resolves.toBeNull();
    },
  );

  it("treats only an absent alert as empty and propagates device errors", async () => {
    const f = fixture();
    f.transport
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "ALERT_NOT_FOUND", message: "alert not found" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "COMMAND_FAILED", message: "device offline" },
      });
    await expect(f.reader.get()).resolves.toBeNull();
    await expect(f.reader.get()).rejects.toThrow("device offline");
  });

  it("fences a native response after cancellation", async () => {
    const f = fixture();
    f.transport.mockImplementation(async () => {
      f.controller.abort(new Error("attempt ended"));
      return {
        ok: true,
        data: {
          message: "Open in “HotUpdaterExample”?",
          items: ["Cancel", "Open"],
        },
      };
    });
    await expect(f.reader.get()).rejects.toThrow("attempt ended");
    await expect(f.reader.get()).rejects.toThrow("attempt ended");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
});
