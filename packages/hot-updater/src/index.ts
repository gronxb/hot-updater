import { deploy } from "@/commands/deploy";
import { version } from "@/package.json";
import { printLogo } from "@/utils/printLogo";
import { Command, Option } from "commander";

printLogo();

const program = new Command();
program
  .name("hot-updater")
  .description("CLI to React Native OTA solution for self-hosted")
  .version(version);

program
  .command("deploy")
  .description("deploy a new version")
  .addOption(
    new Option("-p, --platform <platform>", "specify the platform")
      .choices(["ios", "android"])
      .makeOptionMandatory(true),
  )
  .action(
    (options: {
      platform: "ios" | "android";
    }) => {
      const { platform } = options;
      deploy(platform);
    },
  );

program.parse();
