import {
  envSecrets,
  getHotUpdaterEnvValue,
  isCI,
  isReservedVariableName,
  readLoadedHotUpdaterEnv,
  registerSecretValue,
  secretVariableName,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

/** GitHub refuses a secret larger than 48 KB. */
const MAX_SECRET_BYTES = 48 * 1024;

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u;

const GITHUB_REMOTE_PATTERN =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u;

/**
 * An installation token, such as the `GITHUB_TOKEN` of a workflow run:
 * GitHub gives a workflow's token no `secrets` permission.
 */
const isInstallationToken = (token: string) => token.startsWith("ghs_");

const WORKFLOW_TOKEN_REFUSAL =
  "A workflow's GITHUB_TOKEN can't write secrets: GitHub has no secrets permission for it. Store the secret from your machine, signed in with `gh auth login`, or pass a fine-grained token with the repository permission Secrets: Read and write (Environments: Read and write for an environment) as `token`.";

export interface GitHubActionsOptions {
  /**
   * The repository, as `owner/name`. Defaults to the GitHub repository of
   * the project's `origin` remote.
   */
  readonly repo?: string;
  /**
   * Stores in this environment's secrets instead of the repository's. The
   * environment must exist.
   */
  readonly environment?: string;
  /**
   * A token that writes the repository's secrets. Defaults to `GH_TOKEN` or
   * `GITHUB_TOKEN` unless it is a workflow's token, then to
   * `gh auth token`.
   */
  readonly token?: string;
}

/** The secret `set` stores `name` as, which a workflow maps to its env. */
const githubSecretName = (name: string) => {
  const secretName = secretVariableName(name);
  if (/^GITHUB_/iu.test(secretName)) {
    throw new Error(
      `GitHub refuses secret names that start with GITHUB_, such as ${secretName}. Name the secret otherwise.`,
    );
  }
  if (isReservedVariableName(secretName)) {
    throw new Error(
      `${secretName} changes how a process loads code or which credentials Hot Updater uses, so Hot Updater stores no secret a workflow would set as it. Name the secret otherwise.`,
    );
  }
  return secretName;
};

// execa, tweetnacl, and @noble/hashes load when `set` runs: the config
// file imports this adapter on every command.
const loadExeca = async () => (await import("execa")).execa;

const loadSealing = async () => {
  const [{ default: nacl }, { blake2b }] = await Promise.all([
    import("tweetnacl"),
    import("@noble/hashes/blake2.js"),
  ]);
  return { nacl, blake2b };
};

/** The length of a Curve25519 public key, `nacl.box.publicKeyLength`. */
const PUBLIC_KEY_LENGTH = 32;

const readOriginRepo = async (cwd: string): Promise<string> => {
  const execa = await loadExeca();
  const result = await execa("git", ["remote", "get-url", "origin"], {
    cwd,
    reject: false,
  });
  // The URL may hold credentials: it is never printed.
  const match =
    result.exitCode === 0
      ? GITHUB_REMOTE_PATTERN.exec(result.stdout.trim())
      : null;
  if (!match) {
    throw new Error(
      'githubActions() found no GitHub repository in the project\'s origin remote. Pass the repository as `repo: "owner/name"`.',
    );
  }
  return `${match[1]}/${match[2]}`;
};

const readToken = async (
  option: string | undefined,
  cwd: string,
): Promise<string> => {
  if (option !== undefined) {
    if (!option.trim()) throw new Error("githubActions() `token` is empty.");
    return option.trim();
  }
  const fileEnv = await readLoadedHotUpdaterEnv(cwd);
  let skippedInstallationToken = false;
  for (const variable of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const token = getHotUpdaterEnvValue(fileEnv, variable);
    if (token === undefined) continue;
    if (!isInstallationToken(token)) return token;
    skippedInstallationToken = true;
  }
  if (isCI() || process.env["GITHUB_ACTIONS"] === "true") {
    throw new Error(
      skippedInstallationToken
        ? WORKFLOW_TOKEN_REFUSAL
        : `githubActions() has no token to write secrets with in CI. ${WORKFLOW_TOKEN_REFUSAL}`,
    );
  }
  // gh prefers these variables to its stored login: without them, it
  // returns the login instead of the workflow token skipped above.
  const { GH_TOKEN: _, GITHUB_TOKEN: __, ...ghEnv } = process.env;
  const execa = await loadExeca();
  const result = await execa("gh", ["auth", "token"], {
    env: ghEnv,
    extendEnv: false,
    reject: false,
  });
  const token = result.exitCode === 0 ? result.stdout.trim() : "";
  if (token && !isInstallationToken(token)) return token;
  throw new Error(
    "githubActions() has no GitHub token: sign in with `gh auth login`, or set GH_TOKEN to a fine-grained token with the repository permission Secrets: Read and write (Environments: Read and write for an environment).",
  );
};

const concatBytes = (first: Uint8Array, second: Uint8Array) => {
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);
  return bytes;
};

/**
 * Encrypts `value` for `publicKey` as libsodium's `crypto_box_seal` does,
 * which GitHub opens: an ephemeral X25519 key pair, the nonce
 * BLAKE2b-24(ephemeral public key ‖ public key), and the ephemeral public key
 * before the XSalsa20-Poly1305 box.
 */
const sealedBox = async (value: Uint8Array, publicKey: Uint8Array) => {
  const { nacl, blake2b } = await loadSealing();
  const ephemeral = nacl.box.keyPair();
  try {
    const nonce = blake2b(concatBytes(ephemeral.publicKey, publicKey), {
      dkLen: nacl.box.nonceLength,
    });
    const box = nacl.box(value, nonce, publicKey, ephemeral.secretKey);
    return concatBytes(ephemeral.publicKey, box);
  } finally {
    ephemeral.secretKey.fill(0);
  }
};

const githubError = async (
  response: Response,
  action: string,
  target: string,
  environment: string | undefined,
) => {
  const body = (await response.json().catch(() => undefined)) as
    | { message?: unknown }
    | undefined;
  const message = typeof body?.message === "string" ? ` (${body.message})` : "";
  const needed = response.headers.get("x-accepted-github-permissions");
  const reason =
    response.status === 401
      ? "the token is invalid or expired"
      : response.status === 403
        ? `the token may not write its secrets${needed ? `; GitHub accepts ${needed}` : ""}`
        : response.status === 404
          ? environment === undefined
            ? "the repository does not exist, or the token can't see it"
            : `the repository or its environment ${environment} does not exist, or the token can't see it. Create the environment in the repository's settings first`
          : `GitHub answered ${response.status}`;
  return new Error(`Could not ${action} ${target}: ${reason}${message}.`);
};

/**
 * GitHub Actions secrets of a repository, or of one of its environments, as
 * a write target: `set` encrypts a value for the repository's public key and
 * stores it. GitHub never returns a secret's value, so `get` reads only
 * inside a workflow run, through the environment as `envSecrets()` does: the
 * workflow maps each secret to the variable of the same name, such as
 * `HOT_UPDATER_ASC_API_KEY: ${{ secrets.HOT_UPDATER_ASC_API_KEY }}`.
 * Elsewhere `get` holds nothing.
 *
 * `set` needs a user token, never a workflow's `GITHUB_TOKEN`.
 */
export const githubActions = (
  options: GitHubActionsOptions = {},
): SecretsAdapter => {
  const { environment } = options;
  if (options.repo !== undefined && !REPO_PATTERN.test(options.repo)) {
    throw new Error(
      `githubActions() takes the repository as "owner/name", and ${JSON.stringify(options.repo)} is not one.`,
    );
  }
  if (environment !== undefined && !environment.trim()) {
    throw new Error("githubActions() `environment` is empty.");
  }
  let repo = options.repo;
  const env = envSecrets();

  const where = () =>
    `${repo ?? "the origin repository"}${environment === undefined ? "" : `, environment ${environment}`}`;

  return {
    name: "githubActions",
    get: async (names, context) => {
      if (process.env["GITHUB_ACTIONS"] === "true") {
        return env.get(names, context);
      }
      // No prototype: a secret may be named __proto__.
      const values: Record<string, string | undefined> = Object.create(null);
      for (const name of names) values[name] = undefined;
      return values;
    },
    set: async (name, value, { cwd }) => {
      const secretName = githubSecretName(name);
      registerSecretValue(value);
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > MAX_SECRET_BYTES) {
        throw new Error(
          `${secretName} is ${bytes.length} bytes, and GitHub stores secrets up to 48 KB.`,
        );
      }
      const token = await readToken(options.token, cwd);
      registerSecretValue(token);
      repo ??= await readOriginRepo(cwd);

      const [owner, repoName] = repo.split("/") as [string, string];
      const base =
        environment === undefined
          ? `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/actions/secrets`
          : `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/environments/${encodeURIComponent(environment)}/secrets`;
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "hot-updater",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      };

      const keyResponse = await fetch(`${GITHUB_API_URL}${base}/public-key`, {
        headers,
        redirect: "error",
      });
      if (!keyResponse.ok) {
        throw await githubError(
          keyResponse,
          "read the secrets public key of",
          where(),
          environment,
        );
      }
      const publicKey = (await keyResponse.json()) as {
        key_id?: unknown;
        key?: unknown;
      };
      const key =
        typeof publicKey.key === "string"
          ? Buffer.from(publicKey.key, "base64")
          : undefined;
      if (
        typeof publicKey.key_id !== "string" ||
        key?.length !== PUBLIC_KEY_LENGTH
      ) {
        throw new Error(
          `GitHub returned no secrets public key for ${where()}.`,
        );
      }

      const encrypted = await sealedBox(bytes, new Uint8Array(key));
      const putResponse = await fetch(
        `${GITHUB_API_URL}${base}/${encodeURIComponent(secretName)}`,
        {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            encrypted_value: Buffer.from(encrypted).toString("base64"),
            key_id: publicKey.key_id,
          }),
          redirect: "error",
        },
      );
      if (!putResponse.ok) {
        throw await githubError(
          putResponse,
          `store ${secretName} in`,
          where(),
          environment,
        );
      }
    },
    describe: (name) => {
      const secretName = secretVariableName(name);
      return `GitHub Actions secret ${secretName} of ${where()}, which a workflow reads as env ${secretName}`;
    },
  };
};
