import { Option } from "@commander-js/extra-typings";

export const platformCommandOption = new Option(
  "-p, --platform <platform>",
  "specify the platform",
).choices(["ios", "android"]);

export const interactiveCommandOption = new Option(
  "-i, --interactive",
  "interactive mode",
).default(false);
