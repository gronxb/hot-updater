import type { SecretsAdapter } from "@hot-updater/plugin-core";

const ADAPTER_NAME = "secretManager";
const API_URL = "https://secretmanager.googleapis.com/v1";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Variables an access token is read from as it is: gcloud's, and the one
 * Terraform's Google provider reads, which a job sets from
 * `google-github-actions/auth`'s `access_token` output.
 */
const ACCESS_TOKEN_ENV_NAMES = [
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
] as const;

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9.:-]*$/u;
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/u;
const PREFIX_PATTERN = /^[A-Za-z0-9_-]*$/u;
const VERSION_ID_PATTERN = /^[1-9]\d*$/u;

/**
 * The secret's annotation that lists the versions this adapter added and
 * has not destroyed yet: the only versions it ever destroys.
 */
const VERSIONS_ANNOTATION = "hot-updater-versions";

/** What `set` needs on the secret, checked before it adds a version. */
const SET_PERMISSIONS = [
  "secretmanager.versions.add",
  "secretmanager.versions.access",
  "secretmanager.versions.destroy",
  "secretmanager.secrets.update",
] as const;

/**
 * How long `set` waits, between reads, for the `latest` alias to resolve to
 * the version it added: `latest` is eventually consistent. About 30 seconds.
 */
const LATEST_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000];

/** How often `set` re-reads the secret when another writer changed it. */
const ANNOTATION_ATTEMPTS = 5;

/**
 * What signs the requests: anything with `getAccessToken()`, such as
 * `google-auth-library`'s `GoogleAuth` or an `AuthClient`, or firebase-admin's
 * `cert(...)`, or a function that returns an access token.
 */
export type SecretManagerCredentials =
  | {
      getAccessToken(): Promise<
        | string
        | null
        | undefined
        | { readonly token?: string | null }
        | { readonly access_token?: string }
      >;
    }
  | (() => Promise<string>);

export interface SecretManagerOptions {
  /** The Google Cloud project ID or number that holds the secrets. */
  readonly projectId: string;
  /**
   * Put before each name to make its secret ID, so `secret("asc-api-key")`
   * reads `hot-updater-asc-api-key`. Letters, digits, `-`, and `_`.
   *
   * @default "hot-updater-"
   */
  readonly prefix?: string;
  /**
   * What signs the requests. Without it, `CLOUDSDK_AUTH_ACCESS_TOKEN` or
   * `GOOGLE_OAUTH_ACCESS_TOKEN` as it is, then Application Default
   * Credentials: `gcloud auth application-default login` on your machine,
   * the Workload Identity Federation file `google-github-actions/auth`
   * writes in CI, a service account key in `GOOGLE_APPLICATION_CREDENTIALS`,
   * or the runtime's service account.
   */
  readonly credentials?: SecretManagerCredentials;
}

interface GoogleSecret {
  readonly etag?: string;
  readonly annotations?: Readonly<Record<string, string>>;
}

interface GoogleError {
  readonly code?: number;
  readonly status?: string;
  readonly message?: string;
  readonly details?: readonly { readonly reason?: string }[];
}

interface GoogleResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
  readonly error: GoogleError;
}

/** The fields read from Secret Manager's responses. */
type GoogleJson = Partial<
  Record<
    "error" | "payload" | "data" | "dataCrc32c" | "permissions" | "name",
    unknown
  >
>;

const isRecord = (value: unknown): value is GoogleJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The CRC32C (Castagnoli) checksum Secret Manager verifies payloads with. */
const crc32c = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** The version IDs the secret's annotation lists. */
const trackedVersions = (secret: GoogleSecret): string[] =>
  (secret.annotations?.[VERSIONS_ANNOTATION] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => VERSION_ID_PATTERN.test(entry));

const versionOf = (name: unknown) =>
  typeof name === "string" ? name.slice(name.lastIndexOf("/") + 1) : "";

/** The widest line a message has: the CLI prints no wider. */
const LINE_WIDTH = 76;

/** `text`, such as Google's own message, in lines that fit, broken at spaces. */
const wrap = (text: string): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (line && line.length + 1 + word.length > LINE_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

/** An error of one line each, for a terminal. */
const failure = (lines: readonly string[], cause?: unknown) =>
  new Error(lines.join("\n"), cause === undefined ? undefined : { cause });

const hint = (response: GoogleResponse, permission: string): string[] => {
  const { status, error } = response;
  if (error.details?.some((detail) => detail.reason === "SERVICE_DISABLED")) {
    return [
      "Enable the Secret Manager API in the project:",
      "gcloud services enable secretmanager.googleapis.com --project <project>",
    ];
  }
  if (status === 401) {
    return [
      "Google rejected the access token.",
      "Sign in again with gcloud auth application-default login.",
      "In CI, check the job's Workload Identity Federation.",
    ];
  }
  if (status === 403) {
    return wrap(`The Google identity needs ${permission}.`);
  }
  if (status === 429) {
    return ["Secret Manager's quota is exhausted: try again later."];
  }
  return [];
};

/**
 * An error for a failed request on `resource`, a line each: the HTTP
 * status, the resource, Google's status and message, which name resources
 * but never a value, `notes`, and what to fix.
 */
const requestError = (
  action: string,
  resource: string,
  response: GoogleResponse,
  permission: string,
  notes: readonly string[] = [],
) => {
  const { status, message } = response.error;
  const detail = [status, message?.slice(0, 300)].filter(Boolean).join(": ");
  return failure([
    `${ADAPTER_NAME} couldn't ${action} (${response.status}).`,
    resourceLine(resource),
    ...wrap(detail),
    ...notes,
    ...hint(response, permission),
  ]);
};

/** The line that names a secret: its resource name is a line's worth. */
const resourceLine = (secret: string) => `Secret: ${secret}`;

/** Masks a value in the CLI's output, which loads `@hot-updater/cli-tools`. */
const mask = async (value: string) => {
  const { registerSecretValue } = await import("@hot-updater/cli-tools");
  registerSecretValue(value);
};

const tokenOf = (
  result: Awaited<
    ReturnType<
      Exclude<SecretManagerCredentials, () => unknown>["getAccessToken"]
    >
  >,
) => {
  if (typeof result === "string") return result;
  if (!result) return undefined;
  if ("token" in result) return result.token ?? undefined;
  if ("access_token" in result) return result.access_token;
  return undefined;
};

/**
 * Returns a function that resolves an access token with the
 * `cloud-platform` scope: from `credentials`, else from an access token
 * variable, else from Application Default Credentials through
 * `google-auth-library`, which loads on first use. Each token is masked in
 * the CLI's output.
 */
const createAccessToken = (
  credentials: SecretManagerCredentials | undefined,
  projectId: string,
) => {
  let auth:
    | Promise<{ getAccessToken(): Promise<string | null | undefined> }>
    | undefined;

  const resolve = async (): Promise<string | undefined> => {
    if (typeof credentials === "function") return credentials();
    if (credentials) return tokenOf(await credentials.getAccessToken());
    for (const name of ACCESS_TOKEN_ENV_NAMES) {
      const token = process.env[name]?.trim();
      if (token) return token;
    }
    auth ??= import("google-auth-library")
      // With the project given, a Workload Identity Federation file needs
      // no Cloud Resource Manager lookup, and so no permission for one.
      .then(
        ({ GoogleAuth }) =>
          new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE], projectId }),
      )
      .catch((error: unknown) => {
        auth = undefined;
        throw error;
      });
    const client = await auth;
    try {
      return (await client.getAccessToken()) ?? undefined;
    } catch (error) {
      throw failure(
        [
          `${ADAPTER_NAME} found no Google credentials.`,
          ...wrap(
            error instanceof Error
              ? error.message.split("\n")[0]!
              : String(error),
          ),
          "On your machine, run gcloud auth application-default login.",
          "In CI, use google-github-actions/auth.",
          "Or set GOOGLE_APPLICATION_CREDENTIALS to a service account key.",
          `Or set ${ACCESS_TOKEN_ENV_NAMES.join(" or ")} to a token.`,
        ],
        error,
      );
    }
  };

  return async () => {
    const token = (await resolve())?.trim();
    if (!token) {
      throw new Error(`${ADAPTER_NAME} got no Google access token.`);
    }
    await mask(token);
    return token;
  };
};

/**
 * Secrets from Google Cloud Secret Manager: each name is the secret
 * `<prefix><name>`, read at its `latest` version. Requests go to the REST
 * API, signed by `google-auth-library`, which firebase-admin already
 * installs and which loads on the first read or write, so a config that
 * only uses `firebaseStorage` never loads it.
 *
 * @example
 * secrets: secretManager({ projectId: "my-project" })
 */
export const secretManager = ({
  projectId,
  prefix = "hot-updater-",
  credentials,
}: SecretManagerOptions): SecretsAdapter => {
  const accessToken = createAccessToken(credentials, projectId);

  // Checked on first use, so a config loads without its options.
  const projectPath = () => {
    if (typeof projectId !== "string" || !PROJECT_PATTERN.test(projectId)) {
      throw failure([
        `${ADAPTER_NAME} can't use the projectId ${JSON.stringify(projectId)}.`,
        "Set the Google Cloud project's ID or number.",
      ]);
    }
    if (!PREFIX_PATTERN.test(prefix)) {
      throw failure([
        `${ADAPTER_NAME} can't use the prefix ${JSON.stringify(prefix)}.`,
        'It takes letters, digits, "-", and "_".',
      ]);
    }
    return `projects/${projectId}`;
  };

  const secretId = (name: string) => {
    const id = `${prefix}${name}`;
    if (!SECRET_ID_PATTERN.test(id)) {
      throw failure([
        `${ADAPTER_NAME} can't name a secret ${JSON.stringify(name)}.`,
        `Secret: ${id}`,
        'Secret Manager\'s IDs take up to 255 letters, digits, "-", and "_".',
      ]);
    }
    return id;
  };

  const request = async (
    token: string,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<GoogleResponse> => {
    const authorization = `Bearer ${token}`;
    const response = await fetch(
      `${API_URL}/${path}`,
      body === undefined
        ? { method, headers: { authorization }, redirect: "error" }
        : {
            method,
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
          },
    );
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return {
      status: response.status,
      ok: response.ok,
      body: parsed,
      error:
        isRecord(parsed) && isRecord(parsed.error)
          ? (parsed.error as GoogleError)
          : {},
    };
  };

  /** The `latest` version's ID and value, or undefined when there is none. */
  const accessLatest = async (
    token: string,
    secret: string,
  ): Promise<{ version: string; value: string } | undefined> => {
    const response = await request(
      token,
      "GET",
      `${secret}/versions/latest:access`,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw requestError(
        "read",
        secret,
        response,
        "roles/secretmanager.secretAccessor on the secret",
      );
    }
    const body = isRecord(response.body) ? response.body : undefined;
    const payload = body?.payload;
    const data = isRecord(payload) ? payload.data : undefined;
    if (typeof data !== "string") {
      throw failure([`${ADAPTER_NAME} read no payload.`, resourceLine(secret)]);
    }
    const bytes = Buffer.from(data, "base64");
    const checksum = isRecord(payload) ? payload.dataCrc32c : undefined;
    if (checksum !== undefined && Number(checksum) !== crc32c(bytes)) {
      throw failure([
        `${ADAPTER_NAME} can't trust what it read.`,
        resourceLine(secret),
        "Its checksum doesn't match its payload.",
      ]);
    }
    const value = bytes.toString("utf8");
    await mask(value);
    return { version: versionOf(body?.name), value };
  };

  /**
   * Whether `latest` resolves to `version`, or a newer one another writer
   * added, within about 30 seconds. While `latest` still names an older
   * version, which may be missing or disabled, it reads again; it never
   * throws, so the version `set` stored is always listed.
   */
  const waitForLatest = async (
    token: string,
    secret: string,
    version: string,
  ) => {
    for (const ms of [0, ...LATEST_RETRY_DELAYS_MS]) {
      if (ms > 0) await delay(ms);
      let response: GoogleResponse;
      try {
        response = await request(
          token,
          "GET",
          `${secret}/versions/latest:access`,
        );
      } catch {
        return false;
      }
      if (response.ok) {
        const latest = versionOf(
          isRecord(response.body) ? response.body.name : undefined,
        );
        if (Number(latest) >= Number(version)) return true;
      } else if (
        response.status !== 404 &&
        response.error.status !== "FAILED_PRECONDITION"
      ) {
        return false;
      }
    }
    return false;
  };

  const readSecret = async (
    token: string,
    secret: string,
  ): Promise<GoogleSecret | undefined> => {
    const response = await request(token, "GET", secret);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw requestError(
        "read",
        secret,
        response,
        "secretmanager.secrets.get on the secret",
      );
    }
    return response.body as GoogleSecret;
  };

  const getOrCreateSecret = async (
    token: string,
    parent: string,
    id: string,
  ): Promise<GoogleSecret> => {
    const secret = `${parent}/secrets/${id}`;
    const existing = await readSecret(token, secret);
    if (existing) return existing;
    const created = await request(
      token,
      "POST",
      `${parent}/secrets?secretId=${encodeURIComponent(id)}`,
      { replication: { automatic: {} } },
    );
    if (created.ok) return created.body as GoogleSecret;
    // Another run created it first.
    if (created.status === 409) {
      const raced = await readSecret(token, secret);
      if (raced) return raced;
    }
    throw requestError(
      "create",
      secret,
      created,
      `secretmanager.secrets.create on ${parent}`,
    );
  };

  const assertCanSet = async (token: string, secret: string) => {
    const response = await request(
      token,
      "POST",
      `${secret}:testIamPermissions`,
      { permissions: SET_PERMISSIONS },
    );
    if (!response.ok) {
      throw requestError(
        "check its permissions",
        secret,
        response,
        SET_PERMISSIONS.join(", "),
      );
    }
    const held =
      isRecord(response.body) && Array.isArray(response.body.permissions)
        ? response.body.permissions
        : [];
    const missing = SET_PERMISSIONS.filter((name) => !held.includes(name));
    if (missing.length > 0) {
      throw failure([
        `${ADAPTER_NAME} can't store a value.`,
        resourceLine(secret),
        ...wrap(`The Google identity lacks ${missing.join(", ")} on it.`),
        "It adds a version, then destroys the versions it added before.",
        "Grant roles/secretmanager.admin, or a custom role with:",
        ...wrap(
          "secretmanager.secrets.get, secretmanager.secrets.update, secretmanager.versions.add, secretmanager.versions.destroy, secretmanager.versions.access",
        ),
      ]);
    }
  };

  /**
   * Destroys `version` of `secret`: true once it is destroyed, or already
   * was, false when it could not be, even for a network failure, so it
   * stays listed for the next `set`.
   */
  const destroy = async (token: string, secret: string, version: string) => {
    let response: GoogleResponse;
    try {
      response = await request(
        token,
        "POST",
        `${secret}/versions/${version}:destroy`,
        {},
      );
    } catch {
      return false;
    }
    return (
      response.ok ||
      response.status === 404 ||
      response.error.status === "FAILED_PRECONDITION"
    );
  };

  return {
    name: ADAPTER_NAME,
    get: async (names) => {
      const parent = projectPath();
      const secrets = names.map(
        (name) => `${parent}/secrets/${secretId(name)}`,
      );
      // No prototype: a secret may be named __proto__.
      const values: Record<string, string | undefined> = Object.create(null);
      if (names.length === 0) return values;
      const token = await accessToken();
      const read = await Promise.all(
        secrets.map((secret) => accessLatest(token, secret)),
      );
      names.forEach((name, index) => {
        values[name] = read[index]?.value;
      });
      return values;
    },
    /**
     * Adds `value` as the secret's newest version, creating the secret when
     * it is missing, and waits until the `latest` alias resolves to it. Then
     * it destroys the older versions this adapter added, which the secret's
     * `hot-updater-versions` annotation lists: versions added any other way
     * are never touched. The permissions this needs are checked before
     * anything is written. A version that could not be destroyed stays
     * listed for the next `set`. The annotation is updated against the
     * secret's etag, so a concurrent `set` loses no listed version. When
     * `latest` does not resolve to the new version in time, or the
     * annotation cannot be updated, `set` throws, naming the version it
     * stored.
     */
    set: async (name, value) => {
      const parent = projectPath();
      const id = secretId(name);
      const secret = `${parent}/secrets/${id}`;
      if (typeof value !== "string" || value === "") {
        throw failure([
          `${ADAPTER_NAME} can't store an empty value.`,
          resourceLine(secret),
        ]);
      }
      await mask(value);
      const token = await accessToken();
      const current = await getOrCreateSecret(token, parent, id);
      await assertCanSet(token, secret);

      const data = Buffer.from(value, "utf8");
      const added = await request(token, "POST", `${secret}:addVersion`, {
        payload: {
          data: data.toString("base64"),
          dataCrc32c: String(crc32c(data)),
        },
      });
      const version = versionOf(
        isRecord(added.body) ? added.body.name : undefined,
      );
      if (!added.ok || !VERSION_ID_PATTERN.test(version)) {
        throw requestError(
          "add a version",
          secret,
          added,
          "secretmanager.versions.add on the secret",
        );
      }

      // Destroying the previous version before readers of `latest` see the
      // new one would break them.
      const visible = await waitForLatest(token, secret, version);
      const destroyed = new Set<string>();
      if (visible) {
        const older = trackedVersions(current).filter(
          (entry) => Number(entry) < Number(version),
        );
        const results = await Promise.all(
          older.map((entry) => destroy(token, secret, entry)),
        );
        older.forEach((entry, index) => {
          if (results[index]) destroyed.add(entry);
        });
      }

      const notListed = `record version ${version}, which it stored`;
      const notDestroyed = `The next set won't destroy it: ${VERSIONS_ANNOTATION} misses it.`;
      let base = current;
      let updated: GoogleResponse | undefined;
      try {
        for (let attempt = 0; attempt < ANNOTATION_ATTEMPTS; attempt += 1) {
          if (attempt > 0) {
            await delay(LATEST_RETRY_DELAYS_MS[attempt - 1] ?? 0);
            base = (await readSecret(token, secret)) ?? {};
          }
          const listed = [
            ...new Set([version, ...trackedVersions(base)]),
          ].filter((entry) => !destroyed.has(entry));
          updated = await request(
            token,
            "PATCH",
            `${secret}?updateMask=annotations`,
            {
              ...(base.etag === undefined ? {} : { etag: base.etag }),
              annotations: {
                ...base.annotations,
                [VERSIONS_ANNOTATION]: listed.join(","),
              },
            },
          );
          // A stale etag: another writer changed the secret since it was read.
          if (updated.error.status !== "FAILED_PRECONDITION") break;
        }
      } catch (error) {
        throw failure(
          [
            `${ADAPTER_NAME} couldn't ${notListed}.`,
            resourceLine(secret),
            ...wrap(error instanceof Error ? error.message : String(error)),
            notDestroyed,
          ],
          error,
        );
      }
      if (!updated?.ok) {
        throw requestError(
          notListed,
          secret,
          updated as GoogleResponse,
          "secretmanager.secrets.update on the secret",
          [notDestroyed],
        );
      }
      if (!visible) {
        throw failure([
          `${ADAPTER_NAME} stored version ${version}.`,
          resourceLine(secret),
          "Its latest alias doesn't resolve to that version yet.",
          "It kept the versions it added before: the next set destroys them.",
        ]);
      }
    },
    describe: (name) => {
      const id = `${prefix}${name}`;
      return `projects/${projectId}/secrets/${id} (https://console.cloud.google.com/security/secret-manager/secret/${encodeURIComponent(id)}/versions?project=${encodeURIComponent(projectId)})`;
    },
  };
};
