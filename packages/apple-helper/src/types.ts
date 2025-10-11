import type {
  ApplePlatform,
  NativeBuildOptions,
} from "@hot-updater/plugin-core";

export type DeviceState = "Booted" | "Shutdown";
export type AppleDeviceType = "device" | "simulator";

export type AppleDevice = {
  name: string;
  udid: string;
  version: string;
  platform: ApplePlatform;
  state: DeviceState;
  type: AppleDeviceType;
};

export interface IosNativeRunOptions extends NativeBuildOptions {
  device?: string | boolean;
}
