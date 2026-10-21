import { Option } from "@commander-js/extra-typings";
import type { Platform } from "@hot-updater/plugin-core";

export const PLATFORMS: readonly Platform[] = ["ios", "android"];

export const platformCommandOption = new Option(
  "-p, --platform <platform>",
  "specify the platform",
).choices(["ios", "android"]);

export const interactiveCommandOption = new Option(
  "-i, --interactive",
  "interactive mode",
).default(false);

export const nativeBuildSchemeCommandOption = new Option(
  "-s, --scheme <scheme>",
  "predefined scheme for the native build configuration",
);

export const nativeBuildOutputCommandOption = new Option(
  "-o, --output-path <outputPath>",
  "the path where the artifacts will be generated",
);

export const nativeBuildRegisterCommandOption = new Option(
  "--register",
  "register the release build, its artifact and built-in bundle, with the database and storage in hot-updater.config.ts",
).default(false);

export const nativeBuildJsonCommandOption = new Option(
  "--json",
  "print the build, and with --register its registration, as JSON on the last line of the output",
).default(false);

export const testFlightUploadCommandOption = new Option(
  "--upload <destination>",
  "upload the .ipa to a store: testflight uploads it to App Store Connect with the scheme's App Store Connect API key",
).choices(["testflight"]);

export const playUploadCommandOption = new Option(
  "--upload <destination>",
  "upload the .aab to a store: play-internal releases it to Google Play's internal testing track with the play-service-account secret",
).choices(["play-internal"]);

export const deviceCommandOption = new Option(
  "-d, --device [deviceName | deviceId]",
  "specify the ADB device name or use default",
);

export const portCommandOption = new Option(
  "--port <port>",
  "specify the port number",
);
