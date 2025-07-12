import * as p from "@clack/prompts";
import { Adb } from "@hot-updater/android-helper";
import type { Platform } from "@hot-updater/core";

export const selectTargetDevice = async ({
  interactive,
  deviceOption,
}: {
  platform: Platform;
  deviceOption?: string | boolean;
  interactive: boolean;
}): Promise<{ device?: string }> => {
  // TODO: iOS device select logic
  const availableDevices = await Adb.getDevices();
  if (deviceOption === true && interactive) {
    p.log.error(
      "you can't select device manually with non-interactive cli mode(without -i option).",
    );
    process.exit(1);
  }
  if (deviceOption === true) {
    // if user want to select device manually but not available
    if (!availableDevices.length) {
      p.log.error("you passed -d option but there is no attached adb devices.");
      process.exit(1);
    }
    const device = await p.select({
      message: "Target Device",
      options: availableDevices.map((d) => ({ value: d, label: d })),
    });
    if (p.isCancel(device)) {
      process.exit(1);
    }
    return { device };
  }
  if (typeof deviceOption === "string") {
    if (!availableDevices.includes(deviceOption)) {
      p.log.error(
        `device '${deviceOption}' isn't included in the attached devices.`,
      );
      process.exit(1);
    }
    return { device: deviceOption };
  }
  return {};
};
