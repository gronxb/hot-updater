// @ts-check

import { readFileSync } from "node:fs";

import {
  createCli,
  log,
  maskCredentials,
  setOutput,
} from "../../shared/cli.mjs";
import { runAction } from "./preview.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI reads its credentials through the config's `secrets` adapter,
 * `envSecrets()` by default, which reads the job's environment.
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
  };
};

maskCredentials(env);
const cli = createCli({ env });

const githubToken = env["INPUT_GITHUB_TOKEN"]?.trim();
const repository = env["GITHUB_REPOSITORY"];

try {
  await runAction(
    {
      cli,
      fetch,
      github:
        githubToken && repository
          ? {
              fetch,
              apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com",
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
