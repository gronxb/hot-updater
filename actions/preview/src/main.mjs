// @ts-check

import { readFileSync } from "node:fs";

import { createCli, log, setOutput } from "../../shared/cli.mjs";
import { runAction } from "./preview.mjs";

/**
 * The composite step runs this with the inputs as `INPUT_*` variables. The
 * CLI gets the Console's address and the vault token as
 * `HOT_UPDATER_CONSOLE_URL` and `HOT_UPDATER_VAULT_TOKEN`, which load the
 * vault's deploy credentials, and the same token as
 * `HOT_UPDATER_SIGNING_TOKEN`, which `remoteSigning` sends to the Console.
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
  return {
    action: String(payload.action),
    number: Number(pullRequest.number),
    title: String(pullRequest.title ?? ""),
    headSha: String(pullRequest.head?.sha ?? env["GITHUB_SHA"] ?? ""),
  };
};

const token = env["INPUT_VAULT_TOKEN"]?.trim() ?? "";
if (token) console.log(`::add-mask::${token}`);
const cli = createCli({
  env: {
    ...env,
    HOT_UPDATER_CONSOLE_URL: env["INPUT_CONSOLE_URL"]?.trim() ?? "",
    HOT_UPDATER_VAULT_TOKEN: token,
    HOT_UPDATER_SIGNING_TOKEN: env["HOT_UPDATER_SIGNING_TOKEN"] || token,
  },
});

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
