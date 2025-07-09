// // highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android
//
// import fs from "node:fs";
// import path from "node:path";
// import type {
//   AndroidProjectConfig,
//   Config,
// } from "@react-native-community/cli-types";
// import type { FingerprintSources, RemoteBuildCache } from "@rnef/tools";
// import {
//   RnefError,
//   fetchCachedBuild,
//   formatArtifactName,
//   getLocalBuildCacheBinaryPath,
//   intro,
//   isInteractive,
//   logger,
//   outro,
//   promptConfirm,
//   promptSelect,
// } from "@rnef/tools";
// import type { BuildFlags } from "../buildAndroid/buildAndroid.js";
// import { options } from "../buildAndroid/buildAndroid.js";
// import { runGradle } from "../runGradle.js";
// import { toPascalCase } from "../toPascalCase.js";
// import { Adb } from "./adb";
// import type { AndroidDeviceData } from "./adb";
// import { Emulator } from "./emulator";
// import { listAndroidDevices } from "./listAndroidDevices";
// import { tryInstallAppOnDevice } from "./tryInstallAppOnDevice";
// import { tryLaunchAppOnDevice } from "./tryLaunchAppOnDevice";
//
// export interface Flags extends BuildFlags {
//   appId: string;
//   appIdSuffix: string;
//   mainActivity?: string;
//   port: string;
//   device?: string;
//   binaryPath?: string;
//   user?: string;
//   local?: boolean;
// }
//
// export type AndroidProject = NonNullable<Config["project"]["android"]>;
//
// /**
//  * Starts the app on a connected Android emulator or device.
//  */
// /**
//  * Run Android app on device or emulator
//  */
// export async function runAndroid(
//   androidProject: AndroidProjectConfig,
//   args: Flags,
//   projectRoot: string,
//   remoteCacheProvider: null | (() => RemoteBuildCache) | undefined,
//   fingerprintOptions: FingerprintSources,
// ) {
//   intro("Running Android app");
//
//   normalizeArgs(args, projectRoot);
//
//   const devices = await listAndroidDevices();
//   const device = await selectDevice(devices, args);
//
//   const mainTaskType = device ? "assemble" : "install";
//   const tasks = args.tasks ?? [`${mainTaskType}${toPascalCase(args.variant)}`];
//
//   const artifactName = await formatArtifactName({
//     platform: "android",
//     traits: [args.variant],
//     root: projectRoot,
//     fingerprintOptions,
//   });
//   // 1. First check if the binary path is provided
//   let binaryPath = args.binaryPath;
//
//   // 2. If not, check if the local build is requested
//   if (!binaryPath && !args.local) {
//     binaryPath = getLocalBuildCacheBinaryPath(artifactName);
//   }
//
//   // 3. If not, check if the remote cache is requested
//   if (!binaryPath && !args.local) {
//     try {
//       const cachedBuild = await fetchCachedBuild({
//         artifactName,
//         remoteCacheProvider,
//       });
//       if (cachedBuild) {
//         binaryPath = cachedBuild.binaryPath;
//       }
//     } catch (error) {
//       logger.warn((error as RnefError).message);
//       const shouldContinueWithLocalBuild = await promptConfirm({
//         message: "Would you like to continue with local build?",
//         confirmLabel: "Yes",
//         cancelLabel: "No",
//       });
//       if (!shouldContinueWithLocalBuild) {
//         throw new RnefError("Cancelled run");
//       }
//     }
//   }
//
//   if (device) {
//     if (!(await Adb.getDevices()).find((d) => d === device.deviceId)) {
//       // deviceId is undefined until it's launched, hence overwriting it here
//       device.deviceId = await Emulator.tryLaunchEmulator(device.readableName);
//     }
//     if (device.deviceId) {
//       if (!binaryPath) {
//         await runGradle({ tasks, androidProject, args, artifactName });
//       }
//       await tryInstallAppOnDevice(
//         device,
//         androidProject,
//         args,
//         tasks,
//         binaryPath,
//       );
//       await tryLaunchAppOnDevice(device, androidProject, args);
//     }
//   } else {
//     if ((await Adb.getDevices()).length === 0) {
//       if (isInteractive()) {
//         await selectAndLaunchDevice();
//       } else {
//         logger.debug(
//           "No booted devices or emulators found. Launching first available emulator.",
//         );
//         await Emulator.tryLaunchEmulator();
//       }
//     }
//
//     if (!binaryPath) {
//       await runGradle({ tasks, androidProject, args, artifactName });
//     }
//
//     for (const device of await listAndroidDevices()) {
//       await tryInstallAppOnDevice(
//         device,
//         androidProject,
//         args,
//         tasks,
//         binaryPath,
//       );
//       await tryLaunchAppOnDevice(device, androidProject, args);
//     }
//   }
//
//   outro("Success 🎉.");
// }
//
// /**
//  * Select and launch a device from available options
//  */
// async function selectAndLaunchDevice() {
//   const allDevices = await listAndroidDevices();
//   const device = await promptForDeviceSelection(allDevices);
//
//   if (!device.connected) {
//     await Emulator.tryLaunchEmulator(device.readableName);
//     // list devices once again when emulator is booted
//     const allDevices = await listAndroidDevices();
//     const newDevice =
//       allDevices.find((d) => d.readableName === device.readableName) ?? device;
//     return newDevice;
//   }
//   return device;
// }
//
// /**
//  * Select device based on command line arguments
//  */
// async function selectDevice(devices: AndroidDeviceData[], args: Flags) {
//   const device = args.device ? matchingDevice(devices, args.device) : undefined;
//   if (!device && args.device) {
//     logger.warn(
//       `No devices or emulators found matching "${args.device}". Using available one instead.`,
//     );
//   }
//   return device;
// }
//
// /**
//  * Find matching device by name or ID
//  */
// function matchingDevice(devices: Array<AndroidDeviceData>, deviceArg: string) {
//   const deviceByName = devices.find(
//     (device) => device.readableName === deviceArg,
//   );
//   const deviceById = devices.find((d) => d.deviceId === deviceArg);
//   return deviceByName || deviceById;
// }
//
// /**
//  * Normalize and validate command line arguments
//  */
// function normalizeArgs(args: Flags, projectRoot: string) {
//   if (args.tasks && args.variant) {
//     logger.warn(
//       'Both "--tasks" and "--variant" parameters were passed. Using "--tasks" for building the app.',
//     );
//   }
//
//   if (!args.variant) {
//     args.variant = "debug";
//   }
//
//   // turn on activeArchOnly for debug to speed up local builds
//   if (
//     args.variant !== "release" &&
//     !args.variant.endsWith("Release") &&
//     args.activeArchOnly === undefined &&
//     isInteractive()
//   ) {
//     args.activeArchOnly = true;
//   }
//
//   if (args.binaryPath) {
//     if (args.tasks) {
//       throw new RnefError(
//         'Both "--binary-path" and "--tasks" flags were specified, which are incompatible. Please specify only one.',
//       );
//     }
//
//     args.binaryPath = path.isAbsolute(args.binaryPath)
//       ? args.binaryPath
//       : path.join(projectRoot, args.binaryPath);
//
//     if (args.binaryPath && !fs.existsSync(args.binaryPath)) {
//       throw new RnefError(
//         `"--binary-path" was specified, but the file was not found at "${args.binaryPath}".`,
//       );
//     }
//   }
// }
//
// /**
//  * Prompt user to select device from available options
//  */
// async function promptForDeviceSelection(
//   allDevices: Array<AndroidDeviceData>,
// ): Promise<AndroidDeviceData> {
//   if (!allDevices.length) {
//     throw new RnefError(
//       "No devices and/or emulators connected. Please create emulator with Android Studio or connect Android device.",
//     );
//   }
//   const selected = await promptSelect({
//     message: "Select the device / emulator you want to use",
//     options: allDevices.map((d) => ({
//       label: `${d.readableName}${
//         d.type === "phone" ? " - (physical device)" : ""
//       }${d.connected ? " (connected)" : ""}`,
//       value: d,
//     })),
//   });
//
//   return selected;
// }
//
// export const runOptions = [
//   ...options,
//   {
//     name: "--port <number>",
//     description: "Part for packager.",
//     default: process.env["RCT_METRO_PORT"] || "8081",
//   },
//   {
//     name: "--app-id <string>",
//     description:
//       "Specify an applicationId to launch after build. If not specified, `package` from AndroidManifest.xml will be used.",
//     default: "",
//   },
//   {
//     name: "--app-id-suffix <string>",
//     description: "Specify an applicationIdSuffix to launch after build.",
//     default: "",
//   },
//   {
//     name: "--main-activity <string>",
//     description: "Name of the activity to start",
//   },
//   {
//     name: "--device <string>",
//     description:
//       "Explicitly set the device or emulator to use by name or ID (if launched).",
//   },
//   {
//     name: "--binary-path <string>",
//     description:
//       "Path relative to project root where pre-built .apk binary lives.",
//   },
//   {
//     name: "--user <number>",
//     description: "Id of the User Profile you want to install the app on.",
//   },
//   {
//     name: "--local",
//     description: "Force local build with Gradle wrapper.",
//   },
// ];
