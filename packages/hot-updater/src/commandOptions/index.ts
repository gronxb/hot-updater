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

export const nativeBuildJsonCommandOption = new Option(
  "--json",
  "print the build, its record in Hot Updater, or null and why it has none, as JSON on the last line of the output",
).default(false);

export const testFlightSubmitCommandOption = new Option(
  "--submit <destination>",
  "submit the .ipa to a store: testflight uploads it to App Store Connect with the scheme's App Store Connect API key",
).choices(["testflight"]);

export const playSubmitCommandOption = new Option(
  "--submit <destination>",
  "submit the .aab to a store: play-internal releases it to Google Play's internal testing track with the play-service-account secret",
).choices(["play-internal"]);

export const nativeBuildDryRunCommandOption = new Option(
  "--dry-run",
  "Build, but record and submit nothing: no Hot Updater tracking, no store submission (like npm publish --dry-run)",
);

export const nativeBuildNoCacheCommandOption = new Option(
  "--no-cache",
  "Build even when a build with the same inputs can be reused, such as after a change no key covers, like a provisioning profile",
);
