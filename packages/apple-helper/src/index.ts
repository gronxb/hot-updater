// Main build and install functions (Primary exports)
export { createIosNativeBuild } from "./createIosNativeBuild";
export {
  installAndLaunchIOS,
  buildIosApp,
  launchMacApp,
  type InstallAndLaunchOptions,
} from "./installAndLaunchIOS";

// Essential types
export type { ApplePlatform } from "./utils/platformSupport";
export type {
  Device,
  DeviceType,
  DeviceState,
} from "./utils/deviceManager";
export type {
  BuildFlags,
  BuildResult,
} from "./builder/buildOptions";

