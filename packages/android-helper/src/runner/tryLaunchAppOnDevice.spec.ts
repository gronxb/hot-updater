import { execa } from "execa";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn(async () => ({})) }));
vi.mock("../utils/device", () => ({
  Device: {
    getAdbPath: () => "/sdk/adb",
    tryRunAdbReverse: vi.fn(async () => undefined),
  },
}));

import { Device } from "../utils/device";
import { tryLaunchAppOnDevice } from "./tryLaunchAppOnDevice";

beforeEach(() => vi.clearAllMocks());

it.each([undefined, "8081", "5060"])(
  "launches with only the requested development port: %s",
  async (port) => {
    await tryLaunchAppOnDevice({
      device: {
        deviceId: "emulator-1",
        readableName: "test device",
        connected: true,
        type: "emulator",
      },
      applicationId: "com.example.app",
      packageName: "com.example.app",
      port,
    });

    if (port === undefined) {
      expect(Device.tryRunAdbReverse).not.toHaveBeenCalled();
    } else {
      expect(Device.tryRunAdbReverse).toHaveBeenCalledExactlyOnceWith({
        deviceId: "emulator-1",
        port,
      });
    }
    expect(execa).toHaveBeenCalledWith(
      "/sdk/adb",
      expect.arrayContaining([
        "am",
        "start",
        "com.example.app/com.example.app.MainActivity",
      ]),
    );
  },
);
