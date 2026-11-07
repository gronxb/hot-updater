import {
  isReservedVariableName,
  registerSecretValue,
  secretVariableName,
} from "@hot-updater/cli-tools";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

/** GitHub refuses a secret larger than 48 KB. */
const MAX_SECRET_BYTES = 48 * 1024;

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

// tweetnacl and @noble/hashes load when a secret is written.
const loadSealing = async () => {
  const [{ default: nacl }, { blake2b }] = await Promise.all([
    import("tweetnacl"),
    import("@noble/hashes/blake2.js"),
  ]);
  return { nacl, blake2b };
};

/** The length of a Curve25519 public key, `nacl.box.publicKeyLength`. */
const PUBLIC_KEY_LENGTH = 32;

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
  repo: string,
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
          ? "the repository does not exist, or the token can't see it"
          : `GitHub answered ${response.status}`;
  return new Error(`Could not ${action} ${repo}: ${reason}${message}.`);
};

/** Stores a value as a repository's GitHub Actions secret. */
export interface GitHubSecretWriter {
  /**
   * Stores `value` as the secret `secretVariableName(name)`, such as
   * `HOT_UPDATER_ASC_API_KEY` for `asc-api-key`, which a workflow maps to
   * the variable of the same name.
   */
  readonly set: (name: string, value: string) => Promise<void>;
}

/**
 * Writes `repo`'s GitHub Actions secrets with a user's `token`: a value is
 * encrypted as a libsodium sealed box for the repository's public key.
 * GitHub never returns a secret's value; a workflow reads it from the
 * environment it maps it to. Requests go to api.github.com over HTTPS and
 * follow no redirect, and the token and values are masked in the CLI's
 * output.
 */
export const createGitHubSecretWriter = ({
  repo,
  token,
}: {
  /** The repository, `owner/name`. */
  readonly repo: string;
  readonly token: string;
}): GitHubSecretWriter => ({
  set: async (name, value) => {
    const secretName = githubSecretName(name);
    registerSecretValue(value);
    registerSecretValue(token);
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > MAX_SECRET_BYTES) {
      throw new Error(
        `${secretName} is ${bytes.length} bytes, and GitHub stores secrets up to 48 KB.`,
      );
    }
    const [owner, repoName] = repo.split("/") as [string, string];
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/actions/secrets`;
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
        repo,
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
      throw new Error(`GitHub returned no secrets public key for ${repo}.`);
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
      throw await githubError(putResponse, `store ${secretName} in`, repo);
    }
  },
});
