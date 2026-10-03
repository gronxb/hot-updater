import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Execute = (command: string, args: string[]) => Promise<unknown>;

// App termination must remain pinned even when the automation session ended.
export async function terminateApp(
  target: { platform: "ios" | "android"; deviceId: string; appId: string },
  execute: Execute = (command, args) =>
    execFileAsync(command, args, { timeout: 15_000 }),
): Promise<void> {
  if (!target.deviceId || !target.appId) {
    throw new Error("App termination requires an explicit device and app ID");
  }
  try {
    await (target.platform === "ios"
      ? execute("xcrun", ["simctl", "terminate", target.deviceId, target.appId])
      : execute("adb", [
          "-s",
          target.deviceId,
          "shell",
          "am",
          "force-stop",
          target.appId,
        ]));
  } catch (error) {
    // simctl reports ESRCH for an already stopped app. Other failures leave
    // termination unproved and must fail cleanup.
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    if (
      target.platform === "ios" &&
      /domain=NSPOSIXErrorDomain, code=3\b/.test(stderr) &&
      /No such process/i.test(stderr)
    )
      return;
    throw error;
  }
}
