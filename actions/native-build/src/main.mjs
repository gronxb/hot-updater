// @ts-check

import { appendFileSync } from "node:fs";

import { createCli, log, setOutput } from "../../shared/cli.mjs";
import { cliEnv, parseInputs, runAction } from "./nativeBuild.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI gets the Console's address and the vault token as
 * `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN`, and reads every
 * credential the build needs from the vault.
 */
const env = process.env;

const token = env["INPUT_VAULT_TOKEN"]?.trim();
if (token) console.log(`::add-mask::${token}`);

try {
  const inputs = parseInputs(env);
  await runAction(
    {
      cli: createCli({ env: cliEnv(env, inputs) }),
      setOutput,
      log,
      summary: (markdown) => {
        const file = env["GITHUB_STEP_SUMMARY"];
        if (file) appendFileSync(file, `${markdown}\n`);
      },
    },
    inputs,
  );
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
