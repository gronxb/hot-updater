import path from "path";
import * as p from "@clack/prompts";
import type {
  NativeBuildIosScheme,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import { getCwd } from "@hot-updater/plugin-core";
import { createXcodeBuilder } from "./builder/XcodeBuilder";
import { createDeviceMatcher } from "./runner/deviceMatcher";
import { createDeviceRunner } from "./runner/deviceRunner";
import { createMacRunner } from "./runner/macRunner";
import { createSimulatorRunner } from "./runner/simulatorRunner";
import { listDevicesAndSimulators, selectDevice } from "./utils/deviceManager";

export interface InstallAndLaunchOptions {
  /** Target to install on (auto, device, simulator, or specific device name/UDID) */
  target?: string;
  /** Whether to build the app first */
  build?: boolean;
  /** Path to existing .app bundle (skips building) */
  appPath?: string;
  /** Whether to launch the app after installation */
  launch?: boolean;
}

export const installAndLaunchIOS = async ({
  schemeConfig,
  target = "auto",
  build = true,
  appPath,
  launch = true,
}: {
  schemeConfig: NativeBuildIosScheme;
} & InstallAndLaunchOptions): Promise<void> => {
  const iosProjectRoot = path.join(getCwd(), "ios");
  let finalAppPath = appPath;

  // Build app if needed
  if (build && !appPath) {
    p.log.info("Building iOS app for installation...");

    const buildFlags = enrichIosNativeBuildSchemeOptions({
      scheme: schemeConfig.scheme,
      configuration: schemeConfig.buildConfiguration || "Debug",
      archive: false, // Build .app, not archive
      installPods: true,
    });

    const builder = createXcodeBuilder(iosProjectRoot, "ios");
    const result = await builder.build(buildFlags);
    finalAppPath = result.appPath;
  }

  if (!finalAppPath) {
    throw new Error(
      "No app path provided and build is disabled. Please provide appPath or enable build.",
    );
  }

  // Discover and select target device/simulator
  const selectedDevice = await selectTargetDevice(target);
  if (!selectedDevice) {
    throw new Error("No suitable device or simulator found");
  }

  p.log.info(
    `Selected device: ${selectedDevice.name} (${selectedDevice.type})`,
  );

  // Install and launch based on device type
  try {
    if (selectedDevice.type === "device") {
      // Physical device
      const runner = createDeviceRunner(selectedDevice);
      await runner.installAndLaunch(finalAppPath, {
        launch,
        sourceDir: iosProjectRoot,
      });
    } else if (selectedDevice.type === "simulator") {
      // iOS Simulator
      const runner = createSimulatorRunner(selectedDevice);
      await runner.installAndLaunch(finalAppPath, {
        launch,
        sourceDir: iosProjectRoot,
      });
    } else {
      throw new Error(`Unsupported device type: ${selectedDevice.type}`);
    }

    if (launch) {
      p.log.success(
        `Successfully installed and launched app on ${selectedDevice.name}`,
      );
    } else {
      p.log.success(`Successfully installed app on ${selectedDevice.name}`);
    }
  } catch (error) {
    p.log.error(`Failed to install app on ${selectedDevice.name}: ${error}`);
    throw error;
  }
};

async function selectTargetDevice(target: string) {
  const devices = await listDevicesAndSimulators("ios");
  const matcher = createDeviceMatcher(devices);

  if (target === "auto") {
    // Auto-select: prefer booted simulators, then available devices
    const bootedSimulators = matcher.getBootedDevices("simulator");
    if (bootedSimulators.length > 0) {
      return bootedSimulators[0];
    }

    const availableDevices = matcher.getAvailableDevices({ bootedOnly: false });
    if (availableDevices.length > 0) {
      return availableDevices[0];
    }

    return undefined;
  }

  if (target === "device") {
    // Select any physical device
    return await selectDevice("ios", "device");
  }

  if (target === "simulator") {
    // Select any simulator
    return await selectDevice("ios", "simulator");
  }

  const specificDevice = matcher.findDevice(target);
  if (specificDevice) {
    return specificDevice;
  }

  p.log.warn(
    `Device "${target}" not found. Please select from available devices:`,
  );
  return await selectDevice("ios");
}

export const buildIosApp = async (
  schemeConfig: RequiredDeep<NativeBuildIosScheme>,
  destination: "device" | "simulator" = "simulator",
): Promise<string> => {
  const iosProjectRoot = path.join(getCwd(), "ios");

  const buildFlags: BuildFlags = enrichIosNativeBuildSchemeOptions({
    scheme: schemeConfig.scheme,
    configuration: schemeConfig.buildConfiguration || "Debug",
    destination,
    archive: false,
    installPods: true,
  });

  const builder = createXcodeBuilder(iosProjectRoot, "ios");
  const result = await builder.build(buildFlags);

  return result.appPath;
};

export const launchMacApp = async (
  appPath: string,
  scheme: string,
): Promise<void> => {
  const runner = createMacRunner();

  try {
    // Try Mac Catalyst first, then fallback to regular macOS app
    await runner.launchCatalyst(appPath, scheme);
  } catch (error) {
    p.log.warn(
      `Mac Catalyst launch failed, trying regular macOS app: ${error}`,
    );
    await runner.launch(appPath);
  }
};
