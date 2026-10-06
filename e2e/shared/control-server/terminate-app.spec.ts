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

  it("accepts simctl's observed already-stopped response after cancellation during install", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("Command failed: xcrun simctl terminate"), {
        stderr: [
          "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):",
          "Simulator device failed to terminate org.example.",
          "found nothing to terminate",
          "Underlying error (domain=NSPOSIXErrorDomain, code=3):",
          '\tThe request to terminate "org.example" failed. found nothing to terminate',
          "\tfound nothing to terminate",
        ].join("\n"),
      });
    });

    await expect(
      terminateApp(
        { platform: "ios", deviceId: "leased-udid", appId: "org.example" },
        execute,
      ),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

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
      "domain=NSPOSIXErrorDomain, code=1: found nothing to terminate",
      "domain=OtherErrorDomain, code=3: found nothing to terminate",
      "domain=NSPOSIXErrorDomain, code=3: unexpected termination failure",
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
