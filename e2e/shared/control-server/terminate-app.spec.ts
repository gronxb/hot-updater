import { describe, expect, it, vi } from "vitest";

import { terminateApp } from "./terminate-app.ts";

describe("explicit-device app termination", () => {
  it.each([
    [
      "ios",
      "leased-udid",
      "xcrun",
      ["simctl", "terminate", "leased-udid", "org.example"],
    ],
    [
      "android",
      "emulator-5558",
      "adb",
      ["-s", "emulator-5558", "shell", "am", "force-stop", "org.example"],
    ],
  ] as const)(
    "pins repeated %s termination without an automation session",
    async (platform, deviceId, command, args) => {
      const execute = vi.fn(async () => {});
      const target = { platform, deviceId, appId: "org.example" };
      await terminateApp(target, execute);
      // An externally launched hung process has no new automation session.
      await terminateApp(target, execute);
      expect(execute.mock.calls).toEqual([
        [command, args],
        [command, args],
      ]);
    },
  );

  it("accepts only an already stopped iOS process and fails unavailable devices or denied termination", async () => {
    const target = {
      platform: "ios" as const,
      deviceId: "leased-udid",
      appId: "org.example",
    };
    const execute = vi.fn(async () => {});
    execute.mockRejectedValueOnce({
      stderr: "domain=NSPOSIXErrorDomain, code=3: No such process",
    });
    await expect(terminateApp(target, execute)).resolves.toBeUndefined();
    for (const stderr of [
      "Invalid device: leased-udid",
      "domain=NSPOSIXErrorDomain, code=1: Operation not permitted",
    ]) {
      const failure = Object.assign(new Error("termination failed"), {
        stderr,
      });
      execute.mockRejectedValueOnce(failure);
      await expect(terminateApp(target, execute)).rejects.toBe(failure);
    }
    const failure = new Error("adb device offline");
    execute.mockRejectedValueOnce(failure);
    await expect(
      terminateApp({ ...target, platform: "android" }, execute),
    ).rejects.toBe(failure);
  });
});
