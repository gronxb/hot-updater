// @ts-check

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  appDirectory,
  createBuildLogs,
  createCli,
  log,
  maskCredentials,
  setOutput,
} from "../../shared/cli.mjs";
import { repositoryUrlOf, runAction, runUrlOf } from "./preview.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI reads its credentials from the job's environment, then the config's
 * `secrets` adapter when it sets one.
 */
const env = process.env;

/**
 * The commit the app's directory has checked out, which the CLI builds and
 * deploys: the pull request's head with `ref: head.sha`, or GitHub's merge
 * commit with `actions/checkout`'s default. None without a git checkout.
 */
const checkedOutCommit = () => {
  try {
    return (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: appDirectory(env),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
};

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
    commitSha: String(
      checkedOutCommit() ?? pullRequest.head?.sha ?? env["GITHUB_SHA"] ?? "",
    ),
    headSha: pullRequest.head?.sha ? String(pullRequest.head.sha) : null,
    repositoryUrl: repositoryUrlOf(env, payload),
    runUrl: runUrlOf(env, payload),
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
