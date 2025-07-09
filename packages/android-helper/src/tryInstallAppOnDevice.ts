// // highly credit to https://github.com/callstack/rnef/blob/main/packages/platform-android
//
// import { spinner } from '@clack/prompts';
// import { execa, type ExecaError } from 'execa';
// import { Adb } from './adb';
// // import { findOutputFile } from './findOutputFile';
// import type { AndroidDeviceData } from './adb';
// import { promptForUser } from './listAndroidUsers';
// // import type { AndroidProject, Flags } from './runAndroid';
//
// /**
//  * Try to install app on Android device
//  */
// export async function tryInstallAppOnDevice(
//   device: AndroidDeviceData,
//   androidProject: any,
//   args: any,
//   tasks: string[],
//   binaryPath: string | undefined
// ) {
//   let deviceId;
//   if (!device.deviceId) {
//     console.debug(
//       `No device with id "${device.deviceId}", skipping launching the app.`
//     );
//     return;
//   } else {
//     deviceId = device.deviceId;
//   }
//   let pathToApk: string;
//   if (!binaryPath) {
//     // const outputFilePath = await findOutputFile(
//     //   androidProject,
//     //   tasks,
//     //   deviceId
//     // );
//     // if (!outputFilePath) {
//     //   console.warn(
//     //     "Skipping installation because there's no build output file."
//     //   );
//     //   return;
//     // }
//     // pathToApk = outputFilePath;
//     console.warn("No binary path provided and findOutputFile is not available");
//     return;
//   } else {
//     pathToApk = binaryPath;
//   }
//
//   const adbArgs = ['-s', deviceId, 'install', '-r', '-d'];
//   const user = args.user ?? (await promptForUser(deviceId) as any)?.id;
//
//   if (user !== undefined) {
//     adbArgs.push('--user', `${user}`);
//   }
//
//   adbArgs.push(pathToApk);
//
//   const adbPath = Adb.getAdbPath();
//   const loader = spinner();
//   loader.start(
//     `Installing the app on ${device.readableName} (id: ${deviceId})`
//   );
//   try {
//     await execa(adbPath, adbArgs);
//     loader.stop(
//       `Installed the app on ${device.readableName} (id: ${deviceId}).`
//     );
//   } catch (error) {
//     const errorMessage = (error as ExecaError).stdout || (error as ExecaError).stderr || 'Unknown error';
//     if (typeof errorMessage === 'string' && errorMessage.includes('INSTALL_FAILED_INSUFFICIENT_STORAGE')) {
//       try {
//         loader.message('Trying to install again due to insufficient storage');
//         const appId = args.appId ?? androidProject.applicationId;
//         await execa(adbPath, ['-s', deviceId, 'uninstall', appId]);
//         await execa(adbPath, adbArgs);
//         loader.stop(
//           `Installed the app on ${device.readableName} (id: ${deviceId}).`
//         );
//         return;
//       } catch (error) {
//         loader.stop(
//           `Failed: Uninstalling and installing the app on ${device.readableName} (id: ${deviceId})`,
//           1
//         );
//         const errorMessage = (error as ExecaError).stdout || (error as ExecaError).stderr || 'Unknown error';
//         throw new Error(typeof errorMessage === 'string' ? errorMessage : 'Installation failed');
//       }
//     }
//     loader.stop(
//       `Failed: Installing the app on ${device.readableName} (id: ${deviceId})`,
//       1
//     );
//     throw new Error(typeof errorMessage === 'string' ? errorMessage : 'Installation failed');
//   }
// }
