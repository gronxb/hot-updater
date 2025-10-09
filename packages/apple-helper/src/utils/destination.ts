import type {
  ApplePlatform,
  IosBuildDestination,
} from "@hot-updater/plugin-core";
import { platformConfigs } from "./platform";

export type DeviceType = "device" | "simulator";

const buildDestinationString = ({
  deviceType,
  platform,
  useGeneric,
}: {
  platform: ApplePlatform;
  deviceType: DeviceType;
  useGeneric: boolean;
}) =>
  `${useGeneric ? "generic/" : ""}${deviceType === "device" ? platformConfigs[platform].deviceDestination : platformConfigs[platform].simulatorDestination}`;

/**
 * Resolves IosBuildDestination to xcodebuild destination format
 */
const resolveDestination = ({
  destination,
  useGeneric,
}: {
  destination: IosBuildDestination;
  useGeneric: boolean;
}): string => {
  if (typeof destination === "object") {
    // Handle device with specific id or name
    if ("id" in destination) {
      return `id=${destination.id}`;
    }
    if ("name" in destination) {
      return `name=${destination.name}`;
    }
  }

  switch (destination) {
    case "ios-device":
      return buildDestinationString({
        platform: "ios",
        deviceType: "device",
        useGeneric,
      });
    case "ios-simulator":
      return buildDestinationString({
        platform: "ios",
        deviceType: "simulator",
        useGeneric,
      });
    // TODO: support other apple platforms
    // case "mac":
    //   return buildDestinationString({
    //     platform: "macos",
    //     deviceType: "device",
    //     useGeneric,
    //   });
    // case "mac-catalyst":
    //   return "platform=macOS,variant=Mac Catalyst";
    // case "visionos-device":
    //   return buildDestinationString({
    //     platform: "visionos",
    //     deviceType: "device",
    //     useGeneric,
    //   });
    // case "visionos-simulator":
    //   return buildDestinationString({
    //     platform: "visionos",
    //     deviceType: "simulator",
    //     useGeneric,
    //   });
    // case "tvos":
    //   return buildDestinationString({
    //     platform: "tvos",
    //     deviceType: "device",
    //     useGeneric,
    //   });
    // case "tvos-simulator":
    //   return buildDestinationString({
    //     platform: "tvos",
    //     deviceType: "simulator",
    //     useGeneric,
    //   });
    // case "watchos":
    //   return buildDestinationString({
    //     platform: "watchos",
    //     deviceType: "device",
    //     useGeneric,
    //   });
    // case "watchos-simulator":
    //   return buildDestinationString({
    //     platform: "watchos",
    //     deviceType: "simulator",
    //     useGeneric,
    //   });
  }
};

export const resolveDestinations = ({
  destinations,
  useGeneric,
}: {
  destinations: IosBuildDestination[];
  useGeneric: boolean;
}): string[] => {
  return destinations.map((destination) =>
    resolveDestination({ destination, useGeneric }),
  );
};

export const getDefaultDestination = ({
  platform,
  useGeneric,
}: {
  platform: ApplePlatform;
  useGeneric: boolean;
}) => {
  return buildDestinationString({
    deviceType: "simulator",
    platform,
    useGeneric,
  });
};
