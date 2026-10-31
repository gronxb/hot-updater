// @ts-check

import { cliEnv } from "../../native-build/src/nativeBuild.mjs";
import {
  appendSummary,
  createBuildLogs,
  createCli,
  log,
  maskCredentials,
  setOutput,
} from "../../shared/cli.mjs";
import { runAction } from "./release.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI reads every credential from the job's environment, then the config's
 * `secrets` adapter when it sets one.
 */
const env = process.env;

maskCredentials(env);

try {
  await runAction(
    {
      cli: createCli({ env: cliEnv(env) }),
      buildLogs: createBuildLogs(),
      setOutput,
      log,
      summary: appendSummary,
    },
    env,
  );
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
