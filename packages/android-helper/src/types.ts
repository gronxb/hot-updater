import type { NativeBuildAndroidScheme } from "@hot-updater/plugin-core";

export type EnrichedNativeBuildAndroidScheme =
  Required<NativeBuildAndroidScheme> & {
    device?: AndroidDeviceData;
  };

export type AndroidDeviceData = {
  deviceId: string | undefined;
  readableName: string;
  connected: boolean;
  type: "emulator" | "phone";
};

export type AndroidUser = {
  id: string;
  name: string;
};
