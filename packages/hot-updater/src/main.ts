import { deploy } from "@/commands/deploy";
import { version } from "@/package.json";
import { printLogo } from "@/utils/printLogo";
import { Command, Option } from "commander";
import prompts from "prompts";
import { generateSecretKey } from "./commands/generateSecretKey";

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
    new Option("-p, --platform <platform>", "specify the platform").choices([
      "ios",
      "android",
    ]),
  )
  .addOption(
    new Option(
      "-t, --target-app-version <targetVersion>",
      "specify the platform",
    ),
  )
  .action(
    async (options: {
      targetVersion?: string;
      platform: "ios" | "android";
    }) => {
      if (!options.platform) {
        const response = await prompts([
          {
            type: "select",
            name: "platfrom",
            message: "Which platform do you want to deploy?",
            choices: [
              { title: "ios", value: "#00ff00" },
              { title: "android", value: "#00ff00" },
            ],
          },
        ]);
        options.platform = response.platfrom;
      }
      deploy(options);
    },
  );

program
  .command("generate-secret-key")
  .description("generate a new secret key")
  .action(generateSecretKey);

program.parse();
