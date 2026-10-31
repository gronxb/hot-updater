import fs from "fs";
import path from "path";

import { execa } from "execa";

export interface AdbDevice {
  readonly serial: string;
  /** `device` when it takes commands; else `offline`, `unauthorized`, and so on. */
  readonly state: string;
}

/** The SDK's adb, or the one on the PATH without an SDK in the environment. */
const adbPath = (): string => {
  const sdk = process.env["ANDROID_HOME"] || process.env["ANDROID_SDK_ROOT"];
  const executable = process.platform.startsWith("win") ? "adb.exe" : "adb";
  const fromSdk = sdk && path.join(sdk, "platform-tools", executable);
  return fromSdk && fs.existsSync(fromSdk) ? fromSdk : executable;
};

const adb = async (args: readonly string[]): Promise<string> => {
  try {
    return (await execa(adbPath(), args)).stdout;
  } catch (error) {
    const { code, stderr, stdout, shortMessage } = error as {
      readonly code?: string;
      readonly stderr?: string;
      readonly stdout?: string;
      readonly shortMessage?: string;
    };
    if (code === "ENOENT") {
      throw new Error(
        "adb isn't installed.\nInstall Android platform-tools, or set ANDROID_HOME.",
      );
    }
    throw new Error(
      stderr?.trim() || stdout?.trim() || shortMessage || String(error),
    );
  }
};

/** What `adb devices` lists. */
export const listAdbDevices = async (): Promise<readonly AdbDevice[]> =>
  (await adb(["devices"]))
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .flatMap(([serial, state]) => (serial && state ? [{ serial, state }] : []));

/**
 * The device to install on: `serial`, as adb's own `ANDROID_SERIAL` names it
 * too, or else the only one that takes commands.
 */
export const selectAdbDevice = (
  devices: readonly AdbDevice[],
  serial: string | undefined = process.env["ANDROID_SERIAL"] || undefined,
): AdbDevice => {
  if (serial !== undefined) {
    const device = devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new Error(`${serial} isn't connected.\nList them: adb devices`);
    }
    if (device.state !== "device") {
      throw new Error(`${serial} is ${device.state}.\nList them: adb devices`);
    }
    return device;
  }
  const ready = devices.filter(({ state }) => state === "device");
  const [only] = ready;
  if (only === undefined) {
    throw new Error(
      "No Android device or emulator is connected.\nStart an emulator or connect a phone, then run this again.",
    );
  }
  if (ready.length > 1) {
    throw new Error(
      [
        `${ready.length} Android devices are connected:`,
        ...ready.map(({ serial }) => `  ${serial}`),
        "Pick one with --device <serial>.",
      ].join("\n"),
    );
  }
  return only;
};

/** A failure adb reports for an install another install of the app stands in the way of. */
const NEEDS_UNINSTALL =
  /^INSTALL_FAILED_(UPDATE_INCOMPATIBLE|VERSION_DOWNGRADE)\b/u;

const LAUNCHER_CATEGORY = "android.intent.category.LAUNCHER";

/** An application ID's form, checked before it reaches the device's shell. */
const APP_ID = /^[A-Za-z][A-Za-z0-9_.]*$/u;

/** `<application ID>/<activity>`, as `resolve-activity --brief` prints it. */
const ACTIVITY = /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u;

/**
 * Installs an APK on a device, and opens its launcher activity. `appId` is
 * the APK's own application ID, whatever suffix its build gave it.
 */
export const installOnAndroidDevice = async ({
  serial,
  apkPath,
  appId,
}: {
  readonly serial: string;
  readonly apkPath: string;
  readonly appId: string;
}): Promise<void> => {
  if (!APP_ID.test(appId)) {
    throw new Error(`The APK's application ID isn't valid: ${appId}`);
  }
  try {
    await adb(["-s", serial, "install", "-r", apkPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = /Failure \[([^\]]+)\]/u.exec(message)?.[1] ?? message;
    throw new Error(
      NEEDS_UNINSTALL.test(failure)
        ? `The installed ${appId} can't be replaced: ${failure}\nUninstall it: adb -s ${serial} uninstall ${appId}`
        : `adb couldn't install the APK: ${failure}`,
    );
  }
  const activity = (
    await adb([
      "-s",
      serial,
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      LAUNCHER_CATEGORY,
      appId,
    ])
  )
    .trim()
    .split("\n")
    .at(-1)
    ?.trim();
  if (activity === undefined || !ACTIVITY.test(activity)) {
    throw new Error(
      `${appId} is installed, and has no launcher activity to open.`,
    );
  }
  const started = await adb([
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    LAUNCHER_CATEGORY,
    "-n",
    `'${activity}'`,
  ]);
  // `am start` reports a failure on stdout, on some Android versions with exit 0.
  const error = /^Error: .*$/mu.exec(started)?.[0];
  if (error !== undefined) {
    throw new Error(`${appId} is installed, and didn't open. ${error}`);
  }
};
