import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { crc32c } from "./utils/crc32c";
import { createGoogleAccessToken } from "./utils/googleAccessToken";

const ADAPTER_NAME = "googleSecretManager";
const API_URL = "https://secretmanager.googleapis.com/v1";

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9.:-]*$/u;
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/u;
const PREFIX_PATTERN = /^[A-Za-z0-9_-]*$/u;
const VERSION_ID_PATTERN = /^[1-9]\d*$/u;

/**
 * The secret's annotation that lists the versions this adapter added and
 * has not destroyed yet: the only versions it ever destroys.
 */
export const GOOGLE_SECRET_VERSIONS_ANNOTATION = "hot-updater-versions";

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

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface GoogleSecretManagerOptions {
  /** The Google Cloud project ID or number that holds the secrets. */
  readonly project: string;
  /**
   * Put before each name to make its secret ID, such as `hot-updater-` for
   * `hot-updater-asc-api-key`. Letters, digits, `-`, and `_`.
   */
  readonly prefix?: string;
}

interface GoogleSecret {
  readonly etag?: string;
  readonly annotations?: Readonly<Record<string, string>>;
}

/** The version IDs the secret's annotation lists. */
const trackedVersions = (secret: GoogleSecret): string[] =>
  (secret.annotations?.[GOOGLE_SECRET_VERSIONS_ANNOTATION] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => VERSION_ID_PATTERN.test(entry));

const versionOf = (name: unknown) =>
  typeof name === "string" ? name.slice(name.lastIndexOf("/") + 1) : "";

interface GoogleErrorDetail {
  readonly reason?: string;
}

interface GoogleError {
  readonly code?: number;
  readonly status?: string;
  readonly message?: string;
  readonly details?: readonly GoogleErrorDetail[];
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

const hint = (response: GoogleResponse, permission: string) => {
  const { status, error } = response;
  if (error.details?.some((detail) => detail.reason === "SERVICE_DISABLED")) {
    return " Enable the Secret Manager API (secretmanager.googleapis.com) in the project.";
  }
  if (status === 401) {
    return " Google rejected the access token: sign in again with `gcloud auth application-default login`, or check the job's Workload Identity Federation.";
  }
  if (status === 403) {
    return ` The Google identity needs ${permission}.`;
  }
  if (status === 429) {
    return " Secret Manager's quota is exhausted: try again later.";
  }
  return "";
};

/**
 * An error for a failed request: the HTTP status, Google's status and
 * message, which name resources but never a value, and what to fix.
 */
const requestError = (
  action: string,
  response: GoogleResponse,
  permission: string,
) => {
  const { status, message } = response.error;
  const detail = [status, message?.slice(0, 300)].filter(Boolean).join(": ");
  return new Error(
    `${ADAPTER_NAME} could not ${action} (${response.status}${detail ? ` ${detail}` : ""}).${hint(response, permission)}`,
  );
};

/** Secrets from Google Cloud Secret Manager. */
export const googleSecretManager = ({
  project,
  prefix = "",
}: GoogleSecretManagerOptions): SecretsAdapter => {
  const accessToken = createGoogleAccessToken(ADAPTER_NAME);

  // Checked on first use, so a config loads without its options.
  const projectPath = () => {
    if (typeof project !== "string" || !PROJECT_PATTERN.test(project)) {
      throw new Error(
        `${ADAPTER_NAME} needs the Google Cloud project ID or number as project, and ${JSON.stringify(project)} is not one.`,
      );
    }
    if (!PREFIX_PATTERN.test(prefix)) {
      throw new Error(
        `${ADAPTER_NAME}'s prefix takes letters, digits, "-", and "_", and ${JSON.stringify(prefix)} has others.`,
      );
    }
    return `projects/${project}`;
  };

  const secretId = (name: string) => {
    const id = `${prefix}${name}`;
    if (!SECRET_ID_PATTERN.test(id)) {
      throw new Error(
        `${ADAPTER_NAME} keeps ${JSON.stringify(name)} as the secret ID ${JSON.stringify(id)}, and Secret Manager's IDs take only letters, digits, "-", and "_", up to 255 characters.`,
      );
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
        `read ${secret}`,
        response,
        "roles/secretmanager.secretAccessor on the secret",
      );
    }
    const body = isRecord(response.body) ? response.body : undefined;
    const payload = body?.payload;
    const data = isRecord(payload) ? payload.data : undefined;
    if (typeof data !== "string") {
      throw new Error(`${ADAPTER_NAME} read no payload for ${secret}.`);
    }
    const bytes = Buffer.from(data, "base64");
    const checksum = isRecord(payload) ? payload.dataCrc32c : undefined;
    if (checksum !== undefined && Number(checksum) !== crc32c(bytes)) {
      throw new Error(
        `${ADAPTER_NAME} read ${secret} with a checksum that does not match its payload.`,
      );
    }
    return {
      version: versionOf(body?.name),
      value: bytes.toString("utf8"),
    };
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
        `read ${secret}`,
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
      `create ${secret}`,
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
        `check its permissions on ${secret}`,
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
      throw new Error(
        `${ADAPTER_NAME} stores a value as a new version of ${secret} and destroys the versions it added before, and the Google identity lacks ${missing.join(", ")} on it: grant roles/secretmanager.editor and roles/secretmanager.secretAccessor, or a custom role with secretmanager.secrets.create, secretmanager.secrets.get, secretmanager.secrets.update, secretmanager.versions.add, secretmanager.versions.destroy, and secretmanager.versions.access.`,
      );
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
          `add a version to ${secret}`,
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

      const notListed = `list version ${version}, which it stored, in ${secret}'s ${GOOGLE_SECRET_VERSIONS_ANNOTATION} annotation, so the next set will not destroy it`;
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
                [GOOGLE_SECRET_VERSIONS_ANNOTATION]: listed.join(","),
              },
            },
          );
          // A stale etag: another writer changed the secret since it was read.
          if (updated.error.status !== "FAILED_PRECONDITION") break;
        }
      } catch (error) {
        throw new Error(
          `${ADAPTER_NAME} could not ${notListed} (${error instanceof Error ? error.message : String(error)}).`,
          { cause: error },
        );
      }
      if (!updated?.ok) {
        throw requestError(
          notListed,
          updated as GoogleResponse,
          "secretmanager.secrets.update on the secret",
        );
      }
      if (!visible) {
        throw new Error(
          `${ADAPTER_NAME} stored ${secret} as version ${version}, and its latest alias does not resolve to that version yet, so it kept the versions it added before; the next set destroys them.`,
        );
      }
    },
    describe: (name) => {
      const id = `${prefix}${name}`;
      return `projects/${project}/secrets/${id} (https://console.cloud.google.com/security/secret-manager/secret/${encodeURIComponent(id)}/versions?project=${encodeURIComponent(project)})`;
    },
  };
};
