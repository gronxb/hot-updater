import * as p from "@clack/prompts";
import { matchingDevice } from "../runner/deviceMatcher";
import type { AppleDevice } from "../types";
import { listBootedDevices, listDevicesAndSimulators } from "./deviceManager";

export const selectIosTargetDevice = async ({
  interactive,
  deviceOption,
}: {
  deviceOption?: string | boolean;
  interactive: boolean;
}): Promise<{ device?: AppleDevice }> => {
  const availableDevices = await listDevicesAndSimulators("ios");

  if (deviceOption === true && !interactive) {
    p.log.error(
      "you can't select device manually with non-interactive cli mode(without -i option).",
    );
    process.exit(1);
  }

  if (deviceOption === true || interactive) {
    if (!availableDevices.length) {
      p.log.error("you passed -d option but there is no attached devices.");
      process.exit(1);
    }

    const device = await p.select({
      message: "Target Device",
      options: availableDevices.map((d) => ({
        value: d,
        label: `${d.name} (${d.type}) - ${d.state}`,
        hint: d.udid,
      })),
    });

    if (p.isCancel(device)) {
      process.exit(1);
    }

    return { device };
  }

  if (typeof deviceOption === "string") {
    const matchedDevice = matchingDevice(availableDevices, deviceOption);

    if (!matchedDevice) {
      p.log.error(
        `device '${deviceOption}' isn't included in the attached devices.`,
      );
      process.exit(1);
    }

    return { device: matchedDevice };
  }

  const bootedDevices = await listBootedDevices("ios");
  if (bootedDevices.length > 0) {
    return { device: bootedDevices[0] };
  }

  return { device: undefined };
};
