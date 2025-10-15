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

export interface DevicectlOutput {
  capabilities: object[];
  connectionProperties: object;
  deviceProperties: {
    bootedFromSnapshot: boolean;
    bootedSnapshotName: string;
    ddiServicesAvailable: boolean;
    developerModeStatus: string;
    hasInternalOSBuild: boolean;
    name: string;
    osBuildUpdate: string;
    osVersionNumber: string;
    rootFileSystemIsWritable: boolean;
    bootState?: string;
    screenViewingURL?: string;
  };
  hardwareProperties: {
    cpuType: object;
    deviceType: string;
    ecid: number;
    hardwareModel: string;
    internalStorageCapacity: number;
    isProductionFused: boolean;
    marketingName: string;
    platform: string;
    productType: string;
    reality: string;
    serialNumber: string;
    supportedCPUTypes: object[];
    supportedDeviceFamilies: number[];
    thinningProductType: string;
    udid: string;
  };
  identifier: string;
  tags: unknown[];
  visibilityClass: string;
}

export interface SimctlDevice {
  lastBootedAt?: string;
  dataPath: string;
  dataPathSize: number;
  logPath: string;
  udid: string;
  isAvailable: boolean;
  logPathSize?: number;
  deviceTypeIdentifier: string;
  state: "Booted" | "Shutdown";
  name: string;
}

export interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}
