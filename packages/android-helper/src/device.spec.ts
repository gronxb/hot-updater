import path from "path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installOnAndroidDevice,
  listAdbDevices,
  selectAdbDevice,
} from "./device";

vi.mock("execa", () => ({ execa: vi.fn() }));

const run = vi.mocked(execa) as unknown as ReturnType<typeof vi.fn>;

const ready = (serial: string) => ({ serial, state: "device" });

const argsOf = () => run.mock.calls.map(([, args]) => args as string[]);

/** Answers each adb command as a device does, or by `overrides`. */
const fakeAdb = (
  overrides: { install?: () => never; resolve?: string; start?: string } = {},
) =>
  run.mockImplementation(async (_file: string, args: string[]) => {
    if (args.includes("install")) overrides.install?.();
    if (args.includes("resolve-activity")) {
      return {
        stdout:
          overrides.resolve ??
          "priority=0 preferredOrder=0 match=0x108000\ncom.example.app.sandbox/com.example.MainActivity",
      };
    }
    if (args.includes("am")) {
      return { stdout: overrides.start ?? "Starting: Intent { }" };
    }
    return { stdout: "Success" };
  });

describe("listAdbDevices", () => {
  const env = { ...process.env };

  beforeEach(() => {
    run.mockReset();
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("lists each serial with its state", async () => {
    run.mockResolvedValue({
      stdout:
        "List of devices attached\nemulator-5560\tdevice\nR58M\tunauthorized\n\n",
    });

    await expect(listAdbDevices()).resolves.toEqual([
      { serial: "emulator-5560", state: "device" },
      { serial: "R58M", state: "unauthorized" },
    ]);
  });

  it("uses the PATH's adb without an SDK that has one", async () => {
    process.env["ANDROID_HOME"] = path.join("/nonexistent", "sdk");
    run.mockResolvedValue({ stdout: "List of devices attached\n" });

    await listAdbDevices();

    expect(run.mock.calls[0]?.[0]).toMatch(/^adb(\.exe)?$/u);
  });

  it("says what to install when there is no adb", async () => {
    run.mockRejectedValue(
      Object.assign(new Error("spawn"), { code: "ENOENT" }),
    );

    await expect(listAdbDevices()).rejects.toThrow(
      "adb isn't installed.\nInstall Android platform-tools, or set ANDROID_HOME.",
    );
  });
});

describe("selectAdbDevice", () => {
  const serial = process.env["ANDROID_SERIAL"];

  beforeEach(() => {
    delete process.env["ANDROID_SERIAL"];
  });
  afterEach(() => {
    if (serial === undefined) delete process.env["ANDROID_SERIAL"];
    else process.env["ANDROID_SERIAL"] = serial;
  });

  it("takes the only one that takes commands", () => {
    expect(
      selectAdbDevice([
        { serial: "R58M", state: "unauthorized" },
        ready("emulator-5560"),
      ]).serial,
    ).toBe("emulator-5560");
  });

  it("takes the one named, or ANDROID_SERIAL's, of several", () => {
    const devices = [ready("a"), ready("b")];
    expect(selectAdbDevice(devices, "b").serial).toBe("b");
    process.env["ANDROID_SERIAL"] = "a";
    expect(selectAdbDevice(devices).serial).toBe("a");
  });

  it("gives one next step when none is connected", () => {
    expect(() => selectAdbDevice([])).toThrow(
      "No Android device or emulator is connected.\nStart an emulator or connect a phone, then run this again.",
    );
  });

  it("names the choices when several are connected, rather than picking", () => {
    expect(() => selectAdbDevice([ready("a"), ready("b")])).toThrow(
      "2 Android devices are connected:\n  a\n  b\nPick one with --device <serial>.",
    );
  });

  it("refuses a serial that isn't there, or doesn't take commands", () => {
    expect(() => selectAdbDevice([ready("a")], "z")).toThrow(
      "z isn't connected.\nList them: adb devices",
    );
    expect(() =>
      selectAdbDevice([{ serial: "a", state: "offline" }], "a"),
    ).toThrow("a is offline.\nList them: adb devices");
  });
});

describe("installOnAndroidDevice", () => {
  const input = {
    serial: "emulator-5560",
    apkPath: "/tmp/app.apk",
    appId: "com.example.app.sandbox",
  };

  beforeEach(() => {
    run.mockReset();
  });

  it("installs on that device, then opens the launcher activity of the app the APK names", async () => {
    fakeAdb();

    await installOnAndroidDevice(input);

    expect(argsOf()).toEqual([
      ["-s", "emulator-5560", "install", "-r", "/tmp/app.apk"],
      [
        "-s",
        "emulator-5560",
        "shell",
        "cmd",
        "package",
        "resolve-activity",
        "--brief",
        "-c",
        "android.intent.category.LAUNCHER",
        "com.example.app.sandbox",
      ],
      [
        "-s",
        "emulator-5560",
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LAUNCHER",
        "-n",
        "'com.example.app.sandbox/com.example.MainActivity'",
      ],
    ]);
  });

  it("names the uninstall when another signature stands in the way", async () => {
    fakeAdb({
      install: () => {
        throw Object.assign(new Error("failed"), {
          stderr:
            "adb: failed to install /tmp/app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.example.app.sandbox signatures do not match]",
        });
      },
    });

    await expect(installOnAndroidDevice(input)).rejects.toThrow(
      "The installed com.example.app.sandbox can't be replaced: INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.example.app.sandbox signatures do not match\nUninstall it: adb -s emulator-5560 uninstall com.example.app.sandbox",
    );
    expect(argsOf()).toHaveLength(1);
  });

  it("repeats any other install failure", async () => {
    fakeAdb({
      install: () => {
        throw Object.assign(new Error("failed"), {
          stderr:
            "adb: failed to install x: Failure [INSTALL_FAILED_NO_MATCHING_ABIS]",
        });
      },
    });

    await expect(installOnAndroidDevice(input)).rejects.toThrow(
      "adb couldn't install the APK: INSTALL_FAILED_NO_MATCHING_ABIS",
    );
  });

  it("says the app installed when it has nothing to open", async () => {
    fakeAdb({ resolve: "No activity found" });

    await expect(installOnAndroidDevice(input)).rejects.toThrow(
      "com.example.app.sandbox is installed, and has no launcher activity to open.",
    );
  });

  it("catches a failed start that exits 0", async () => {
    fakeAdb({
      start: "Starting: Intent { }\nError: Activity class does not exist.",
    });

    await expect(installOnAndroidDevice(input)).rejects.toThrow(
      "com.example.app.sandbox is installed, and didn't open. Error: Activity class does not exist.",
    );
  });

  it("never hands the device's shell an ID that isn't one", async () => {
    await expect(
      installOnAndroidDevice({ ...input, appId: "com.example;reboot" }),
    ).rejects.toThrow("The APK's application ID isn't valid");
    expect(run).not.toHaveBeenCalled();
  });
});
