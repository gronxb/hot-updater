import {
  getCwd,
  getHotUpdaterEnvValue,
  nonInteractiveReason,
  p,
  readLoadedHotUpdaterEnv,
  registerSecretValue,
  secretVariableName,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";
import { execa } from "execa";

import { githubActions } from "../../githubActions";
import { ui } from "../cli-ui";

/**
 * A secrets adapter that writes a repository's GitHub Actions secrets with
 * a user's token, as `githubActions()` does: `set(name)` stores the secret
 * `secretVariableName(name)`, which a workflow maps to the same variable.
 */
export type CreateGitHubSecrets = (options: {
  /** The repository, `owner/name`. */
  readonly repo: string;
  readonly token: string;
}) => SecretsAdapter;

const GITHUB_REMOTE_PATTERN =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;

/** The `owner/repo` a GitHub remote's URL names, if it is one. */
export const parseGitHubRemote = (url: string): string | undefined => {
  const match = GITHUB_REMOTE_PATTERN.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
};

/** The project's GitHub repository: `origin`'s, else the first GitHub remote's. */
export const findGitHubRepository = async (
  cwd: string,
): Promise<string | undefined> => {
  const remotes = await execa("git", ["remote"], { cwd, reject: false });
  if (remotes.exitCode !== 0) return undefined;
  const names = remotes.stdout.split("\n").filter(Boolean);
  const ordered = [
    ...names.filter((name) => name === "origin"),
    ...names.filter((name) => name !== "origin"),
  ];
  for (const name of ordered) {
    const url = await execa("git", ["remote", "get-url", name], {
      cwd,
      reject: false,
    });
    const repository =
      url.exitCode === 0 ? parseGitHubRemote(url.stdout) : undefined;
    if (repository) return repository;
  }
  return undefined;
};

/** An installation token, such as a workflow's `GITHUB_TOKEN`, which can't write secrets. */
const isInstallationToken = (token: string) => token.startsWith("ghs_");

/**
 * The developer's GitHub token, as `githubActions()` reads it: `GH_TOKEN` or
 * `GITHUB_TOKEN`, in the environment or `.env.hotupdater`, else the GitHub
 * CLI's (`gh auth token`), never an installation token.
 */
export const findGitHubToken = async (
  cwd: string = getCwd(),
): Promise<string | undefined> => {
  const fileEnv = await readLoadedHotUpdaterEnv(cwd);
  for (const variable of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const token = getHotUpdaterEnvValue(fileEnv, variable);
    if (token && !isInstallationToken(token)) return token;
  }
  // gh prefers these variables to its stored login: without them, it
  // returns the login instead of the installation token skipped above.
  const { GH_TOKEN: _, GITHUB_TOKEN: __, ...ghEnv } = process.env;
  const gh = await execa("gh", ["auth", "token", "--hostname", "github.com"], {
    env: ghEnv,
    extendEnv: false,
    reject: false,
    timeout: 10_000,
  }).catch(() => undefined);
  const token = gh?.exitCode === 0 ? gh.stdout.trim() : "";
  return token && !isInstallationToken(token) ? token : undefined;
};

export type GitHubSecretOffer =
  /** No terminal, GitHub remote, or token: nothing was asked. */
  | "unavailable"
  /** The developer said no, or cancelled. */
  | "declined"
  | "stored"
  /** The write failed, which was reported: the key's file still holds it. */
  | "failed";

/**
 * Offers once to store an issued key's `value` as the GitHub Actions secret
 * CI's `envSecrets()` reads `name` from (`secretVariableName(name)`), when the
 * project has a GitHub remote and the developer a token. A failed write is
 * reported, never thrown: the key is in `file` either way.
 */
export const offerGitHubSecret = async ({
  name,
  value,
  file,
  createSecrets = githubActions,
  findRepository = findGitHubRepository,
  findToken = findGitHubToken,
}: {
  readonly name: string;
  readonly value: string;
  /** The file that holds the key, which a failure points to. */
  readonly file: string;
  /** The adapter that writes the secret, `githubActions()` unless set. */
  readonly createSecrets?: CreateGitHubSecrets;
  readonly findRepository?: (cwd: string) => Promise<string | undefined>;
  readonly findToken?: (cwd: string) => Promise<string | undefined>;
}): Promise<GitHubSecretOffer> => {
  if (nonInteractiveReason() !== undefined) return "unavailable";
  const cwd = getCwd();
  const repository = await findRepository(cwd);
  if (!repository) return "unavailable";
  const token = await findToken(cwd);
  if (!token) return "unavailable";
  registerSecretValue(token);

  const variable = secretVariableName(name);
  const answer = await p.confirm({
    message: `Store it as the GitHub Actions secret ${variable} of ${repository}, which CI builds read?`,
    initialValue: true,
  });
  // A cancel is a no: the key is in its file already.
  if (p.isCancel(answer) || !answer) return "declined";

  try {
    const secrets = createSecrets({ repo: repository, token });
    if (secrets.set === undefined) {
      throw new Error(`the ${secrets.name} secrets adapter stores nothing.`);
    }
    await secrets.set(name, value, { cwd });
  } catch (error) {
    p.log.warn(
      `Storing ${variable} in ${repository}'s GitHub Actions secrets failed: ${error instanceof Error ? error.message : String(error)}\nStore the contents of ${file} as that secret yourself.`,
    );
    return "failed";
  }
  p.log.success(
    ui.block("GitHub Actions secret stored", [
      ui.kv("Secret", variable),
      ui.kv("Repository", repository),
      ui.kv("Workflow", `env: ${variable}: \${{ secrets.${variable} }}`),
    ]),
  );
  return "stored";
};
