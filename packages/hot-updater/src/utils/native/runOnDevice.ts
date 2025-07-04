// import * as p from "@clack/prompts";
// import type { ConfigResponse, Platform } from "@hot-updater/plugin-core";
// import { execa } from "execa";
// import { getDevices } from "./android/utils/adb";
// import { Config } from 'es-git';
//
// async function installAndLaunchAndroid(
//   artifactPath: string,
//   config: ConfigResponse,
// ) {
//   const devices = await getDevices();
//   if (devices.length === 0) {
//     p.log.error("No Android devices found.");
//     return;
//   }
//
//   const device = await p.select({
//     message: "Select a device to run the app on",
//     options: devices.map((d) => ({ label: d, value: d })),
//   });
//
//   if (p.isCancel(device)) {
//     return;
//   }
//
//   const androidConfig = config.nativeBuild.android;
//   const packageName = androidConfig.packageName;
//
//   if (!packageName) {
//     p.log.error("No package name found in config");
//     return;
//   }
//
//   await execa("adb", ["-s", device, "install", "-r", artifactPath]);
//   await execa("adb", [
//     "-s",
//     device,
//     "shell",
//     "monkey",
//     "-p",
//     packageName,
//     "-c",
//     "android.intent.category.LAUNCHER",
//     "1",
//   ]);
//
//   p.log.success(`Successfully launched ${packageName} on ${device}`);
// }
//
// async function installAndLaunchIOS(artifactPath: string, config: Config) {
//   // TODO: implement iOS logic
//   p.log.warn("iOS is not supported yet.");
// }
//
// export async function installAndLaunchApp(
//   platform: Platform,
//   artifactPath: string,
//   config: Config,
// ) {
//   if (platform === "android") {
//     await installAndLaunchAndroid(artifactPath, config);
//   } else if (platform === "ios") {
//     await installAndLaunchIOS(artifactPath, config);
//   }
// }
