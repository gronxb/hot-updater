// @ts-check

import { appendFileSync } from "node:fs";

import {
  createBuildLogs,
  createCli,
  log,
  maskCredentials,
  setOutput,
} from "../../shared/cli.mjs";
import { cliEnv, parseInputs, runAction } from "./nativeBuild.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI reads every credential the build needs through the config's
 * `secrets` adapter, `envSecrets()` by default, which reads the job's environment.
 */
const env = process.env;

maskCredentials(env);

try {
  const inputs = parseInputs(env);
  await runAction(
    {
      cli: createCli({ env: cliEnv(env) }),
      buildLogs: createBuildLogs(),
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
