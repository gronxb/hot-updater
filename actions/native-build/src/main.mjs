// @ts-check

import {
  appendSummary,
  createBuildLogs,
  createCli,
  log,
  maskCredentials,
  setOutput,
} from "../../shared/cli.mjs";
import { cliEnv, parseInputs, runAction } from "./nativeBuild.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI reads every credential the build needs from the job's environment,
 * then the config's `secrets` adapter when it sets one.
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
      summary: appendSummary,
    },
    inputs,
  );
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
