// @ts-check

import { readFileSync } from "node:fs";

import {
  createBuildLogs,
  createCli,
  log,
  maskCredentials,
  setOutput,
} from "../../shared/cli.mjs";
import { repositoryUrlOf, runAction } from "./preview.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI reads its credentials from the job's environment, then the config's
 * `secrets` adapter when it sets one.
 */
const env = process.env;

const readEvent = () => {
  const eventPath = env["GITHUB_EVENT_PATH"];
  const payload = eventPath
    ? JSON.parse(readFileSync(eventPath, "utf8"))
    : undefined;
  const pullRequest = payload?.pull_request;
  if (!pullRequest) {
    throw new Error(
      "Run the preview action on pull_request events: types opened, synchronize, reopened, and closed.",
    );
  }
  const head = pullRequest.head?.repo?.full_name;
  return {
    action: String(payload.action),
    // A fork's pull request gets no secrets; a deleted fork has no repo.
    fromFork: head !== payload.repository?.full_name,
    number: Number(pullRequest.number),
    title: String(pullRequest.title ?? ""),
    headSha: String(pullRequest.head?.sha ?? env["GITHUB_SHA"] ?? ""),
    repositoryUrl: repositoryUrlOf(env, payload),
  };
};

maskCredentials(env);
// The token may write the repository's contents: only this process calls
// GitHub, and the project's CLI, its builds, and their scripts never see it.
const { INPUT_GITHUB_TOKEN: githubInput, ...cliEnv } = env;
const cli = createCli({ env: cliEnv });

const githubToken = githubInput?.trim();
const repository = env["GITHUB_REPOSITORY"];

try {
  await runAction(
    {
      cli,
      buildLogs: createBuildLogs(),
      github:
        githubToken && repository
          ? {
              fetch,
              apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com",
              serverUrl: env["GITHUB_SERVER_URL"] ?? "https://github.com",
              repository,
              token: githubToken,
            }
          : null,
      setOutput,
      log,
    },
    env,
    readEvent(),
  );
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
