import { Option } from "@commander-js/extra-typings";

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
