import {
  getHotUpdaterEnvValue,
  readLoadedHotUpdaterEnv,
  registerSecretValue,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

const DEFAULT_SITE_URL = "https://app.infisical.com";
const REQUEST_TIMEOUT_MS = 30_000;
/** A token this close to its expiry is renewed before a request. */
const TOKEN_RENEW_MARGIN_MS = 60_000;
const MESSAGE_LIMIT = 200;

/** The variables Infisical's own CLI reads, so one set serves both. */
const TOKEN_ENV = "INFISICAL_TOKEN";
const CLIENT_ID_ENV = "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID";
const CLIENT_SECRET_ENV = "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET";
const IDENTITY_ID_ENV = "INFISICAL_MACHINE_IDENTITY_ID";
/** What a GitHub Actions job with `id-token: write` sets. */
const OIDC_REQUEST_URL_ENV = "ACTIONS_ID_TOKEN_REQUEST_URL";
const OIDC_REQUEST_TOKEN_ENV = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

/** How `infisical()` signs in to Infisical. */
export type InfisicalAuth =
  | {
      /**
       * A machine identity's Universal Auth client ID and secret, by default
       * from `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and
       * `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`.
       */
      readonly method: "universal-auth";
      readonly clientId?: string;
      readonly clientSecret?: string;
    }
  | {
      /**
       * A machine identity's OIDC Auth with the GitHub Actions ID token of
       * the job, which needs `permissions: id-token: write`. The identity's
       * ID is by default from `INFISICAL_MACHINE_IDENTITY_ID`.
       */
      readonly method: "github-oidc";
      readonly identityId?: string;
      /**
       * The ID token's audience, as the identity's Audiences setting lists
       * it. GitHub's default is the repository owner's URL, such as
       * `https://github.com/octo-org`, which is also Infisical's.
       */
      readonly audience?: string;
    }
  | {
      /**
       * An access token, by default from `INFISICAL_TOKEN`: one
       * `infisical login` printed, or `infisical user get token` prints.
       */
      readonly method: "token";
      readonly token?: string;
    };

export interface InfisicalSecretsOptions {
  /**
   * Infisical's URL: `https://eu.infisical.com` for EU Cloud, or your own
   * instance's. HTTPS, or HTTP on a loopback address.
   *
   * @default "https://app.infisical.com"
   */
  readonly siteUrl?: string;
  /** The project's ID, from its Project Settings. */
  readonly projectId: string;
  /** The environment's slug, such as `prod`. */
  readonly environment: string;
  /**
   * The folder the secrets are in.
   *
   * @default "/"
   */
  readonly path?: string;
  /**
   * How to sign in. By default the first of `INFISICAL_TOKEN`, Universal
   * Auth from `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and
   * `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`, and GitHub OIDC with
   * `INFISICAL_MACHINE_IDENTITY_ID` in a GitHub Actions job that can request
   * an ID token.
   */
  readonly auth?: InfisicalAuth;
}

interface AccessToken {
  readonly token: string;
  /** When it expires, in milliseconds since the epoch; `Infinity` if unknown. */
  readonly expiresAt: number;
}

/** `value[key]` of a JSON object, `undefined` for anything else. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const isLoopback = (url: URL) =>
  url.hostname === "localhost" ||
  url.hostname === "127.0.0.1" ||
  url.hostname === "[::1]";

/** HTTPS, or HTTP on a loopback address, without credentials. */
const isSafeUrl = (url: URL) =>
  (url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopback(url))) &&
  !url.username &&
  !url.password;

const normalizeSiteUrl = (siteUrl: string) => {
  const invalid = () =>
    new Error(
      `infisical() takes siteUrl as an HTTPS URL, or HTTP on a loopback address, without credentials, a query, or a fragment, and ${JSON.stringify(siteUrl)} is not one.`,
    );
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw invalid();
  }
  if (!isSafeUrl(url) || url.search || url.hash) {
    throw invalid();
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
};

const normalizeFolder = (path: string) => {
  const trimmed = path.trim().replace(/\/+$/u, "");
  return trimmed.startsWith("/") ? trimmed || "/" : `/${trimmed}`;
};

const oneLine = (value: string) => {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > MESSAGE_LIMIT
    ? `${line.slice(0, MESSAGE_LIMIT - 1)}…`
    : line;
};

/** The `error` and `message` Infisical answers a refusal with. */
const readRefusal = async (response: Response) => {
  try {
    const body: unknown = await response.json();
    const error = field(body, "error");
    const message = field(body, "message");
    return {
      error: typeof error === "string" ? error : undefined,
      message: typeof message === "string" ? oneLine(message) : undefined,
    };
  } catch {
    // Not JSON: the status says enough.
    return {};
  }
};

/**
 * Secrets in [Infisical](https://infisical.com), Cloud or your own instance:
 * each name is a secret in one project, environment, and folder, and a
 * credential with several fields is one JSON value. `set` creates the secret
 * or updates its value. It reads and writes through Infisical's REST API
 * with `fetch`, signed in as a machine identity with Universal Auth or
 * GitHub OIDC, or with an access token.
 *
 * @example
 * secrets: infisical({ projectId: "…", environment: "prod" }),
 */
export const infisical = ({
  siteUrl = DEFAULT_SITE_URL,
  projectId,
  environment,
  path = "/",
  auth,
}: InfisicalSecretsOptions): SecretsAdapter => {
  const baseUrl = normalizeSiteUrl(siteUrl);
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new Error("infisical() needs the projectId of your project.");
  }
  if (typeof environment !== "string" || !environment.trim()) {
    throw new Error(
      'infisical() needs the slug of the environment, such as "prod".',
    );
  }
  const folder = normalizeFolder(path);
  const where = `project ${projectId}, environment ${environment}, folder ${folder}`;

  const send = async (
    url: string,
    init: RequestInit,
    action: string,
  ): Promise<Response> => {
    try {
      return await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // What fetch threw may quote the request: name only the host.
      throw new Error(`Could not reach ${new URL(url).origin} to ${action}.`);
    }
  };

  /**
   * The error for a refusal. A sign-in's 403 or 404 concerns no project, so
   * it names `siteUrl` instead.
   */
  const refuse = async (
    response: Response,
    action: string,
    signingIn = false,
  ) => {
    const { error, message } = await readRefusal(response);
    const detail = message
      ? `: ${message}${/[.!?]$/u.test(message) ? "" : "."}`
      : ".";
    // Infisical answers a malformed or revoked token with 403 TokenError.
    if (response.status === 401 || error === "TokenError") {
      return new Error(
        `Infisical at ${baseUrl} rejected the credentials to ${action} (${response.status})${detail} Check the identity's credentials or the access token, and that it has not expired.`,
      );
    }
    if (signingIn) {
      return new Error(
        `Infisical at ${baseUrl} answered ${response.status} to ${action}${detail} Check siteUrl and the identity's authentication settings.`,
      );
    }
    if (response.status === 403) {
      return new Error(
        `Infisical at ${baseUrl} does not let the identity ${action} in ${where} (403)${detail} Give it a project role that allows it.`,
      );
    }
    if (response.status === 404) {
      return new Error(
        `Infisical at ${baseUrl} found no ${where} to ${action} (404)${detail} Check projectId, environment, and path.`,
      );
    }
    return new Error(
      `Infisical at ${baseUrl} answered ${response.status} to ${action}${detail}`,
    );
  };

  const signIn = async (
    route: string,
    body: Record<string, string>,
    action: string,
  ): Promise<AccessToken> => {
    const response = await send(
      `${baseUrl}${route}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      action,
    );
    if (!response.ok) throw await refuse(response, action, true);
    const answer: unknown = await response.json().catch(() => undefined);
    const token = field(answer, "accessToken");
    if (typeof token !== "string" || !token) {
      throw new Error(
        `Infisical at ${baseUrl} answered ${action} without an access token.`,
      );
    }
    registerSecretValue(token);
    const expiresIn = field(answer, "expiresIn");
    return {
      token,
      expiresAt:
        typeof expiresIn === "number" && expiresIn > 0
          ? Date.now() + expiresIn * 1000
          : Number.POSITIVE_INFINITY,
    };
  };

  const githubIdToken = async (requestUrl: string, requestToken: string) => {
    const action = "request the GitHub Actions ID token";
    registerSecretValue(requestToken);
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      throw new Error(`${OIDC_REQUEST_URL_ENV} is not a URL.`);
    }
    if (!isSafeUrl(url)) {
      throw new Error(`${OIDC_REQUEST_URL_ENV} is not an HTTPS URL.`);
    }
    const audience = auth?.method === "github-oidc" ? auth.audience : undefined;
    if (audience) url.searchParams.set("audience", audience);
    const response = await send(
      url.href,
      {
        headers: {
          Accept: "application/json",
          Authorization: `bearer ${requestToken}`,
        },
      },
      action,
    );
    if (!response.ok) {
      throw new Error(
        `GitHub answered ${response.status} to ${action}: give the job \`permissions: id-token: write\`.`,
      );
    }
    const answer: unknown = await response.json().catch(() => undefined);
    const jwt = field(answer, "value");
    if (typeof jwt !== "string" || !jwt) {
      throw new Error(`GitHub answered ${action} without a token.`);
    }
    registerSecretValue(jwt);
    return jwt;
  };

  const authenticate = async (cwd: string): Promise<AccessToken> => {
    const fileEnv = await readLoadedHotUpdaterEnv(cwd);
    const read = (name: string) => getHotUpdaterEnvValue(fileEnv, name);
    const method =
      auth?.method ??
      (read(TOKEN_ENV)
        ? "token"
        : read(CLIENT_ID_ENV) && read(CLIENT_SECRET_ENV)
          ? "universal-auth"
          : read(IDENTITY_ID_ENV) && read(OIDC_REQUEST_URL_ENV)
            ? "github-oidc"
            : undefined);

    switch (method) {
      case "token": {
        const token =
          (auth?.method === "token" ? auth.token : undefined) ??
          read(TOKEN_ENV);
        if (!token) {
          throw new Error(
            `infisical() signs in with an access token from ${TOKEN_ENV}, and it is not set.`,
          );
        }
        registerSecretValue(token);
        return { token, expiresAt: Number.POSITIVE_INFINITY };
      }
      case "universal-auth": {
        const options = auth?.method === "universal-auth" ? auth : undefined;
        const clientId = options?.clientId ?? read(CLIENT_ID_ENV);
        const clientSecret = options?.clientSecret ?? read(CLIENT_SECRET_ENV);
        if (!clientId || !clientSecret) {
          throw new Error(
            `infisical() signs in with Universal Auth from ${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV}, and ${clientId ? CLIENT_SECRET_ENV : CLIENT_ID_ENV} is not set.`,
          );
        }
        registerSecretValue(clientSecret);
        return signIn(
          "/api/v1/auth/universal-auth/login",
          { clientId, clientSecret },
          "sign in with Universal Auth",
        );
      }
      case "github-oidc": {
        const options = auth?.method === "github-oidc" ? auth : undefined;
        const identityId = options?.identityId ?? read(IDENTITY_ID_ENV);
        if (!identityId) {
          throw new Error(
            `infisical() signs in with GitHub OIDC as the machine identity ${IDENTITY_ID_ENV} names, and it is not set.`,
          );
        }
        const requestUrl = read(OIDC_REQUEST_URL_ENV);
        const requestToken = read(OIDC_REQUEST_TOKEN_ENV);
        if (!requestUrl || !requestToken) {
          throw new Error(
            `infisical() signs in with GitHub OIDC in a GitHub Actions job that can request an ID token, and ${OIDC_REQUEST_URL_ENV} is not set: give the job \`permissions: id-token: write\`.`,
          );
        }
        const jwt = await githubIdToken(requestUrl, requestToken);
        return signIn(
          "/api/v1/auth/oidc-auth/login",
          { identityId, jwt },
          "sign in with GitHub OIDC",
        );
      }
      default:
        throw new Error(
          `infisical() found no way to sign in to Infisical: set ${TOKEN_ENV}, or ${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV} for Universal Auth, or ${IDENTITY_ID_ENV} in a GitHub Actions job with \`permissions: id-token: write\`.`,
        );
    }
  };

  let pendingToken: Promise<AccessToken> | undefined;
  const accessToken = async (cwd: string) => {
    if (pendingToken) {
      const current = await pendingToken.catch(() => undefined);
      if (current && current.expiresAt - TOKEN_RENEW_MARGIN_MS > Date.now()) {
        return current.token;
      }
    }
    pendingToken = authenticate(cwd);
    pendingToken.catch(() => {
      pendingToken = undefined;
    });
    return (await pendingToken).token;
  };

  const secretUrl = (name: string, query?: Record<string, string>) => {
    const url = new URL(
      `${baseUrl}/api/v4/secrets/${encodeURIComponent(name)}`,
    );
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.href;
  };

  const authorized = async (cwd: string, headers?: Record<string, string>) => ({
    Accept: "application/json",
    Authorization: `Bearer ${await accessToken(cwd)}`,
    ...headers,
  });

  /**
   * The names the folder holds, its imports' included, without their values.
   * Infisical answers 404 alike for a missing secret, environment, folder,
   * or project, so `get` lists the folder first: a 404 here is the
   * environment's, the folder's, or the project's, and throws.
   */
  const listNames = async (cwd: string) => {
    const action = "list the secrets";
    const url = new URL(`${baseUrl}/api/v4/secrets`);
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("environment", environment);
    url.searchParams.set("secretPath", folder);
    url.searchParams.set("viewSecretValue", "false");
    url.searchParams.set("include_imports", "true");
    const response = await send(
      url.href,
      { headers: await authorized(cwd) },
      action,
    );
    if (!response.ok) throw await refuse(response, action);
    const answer: unknown = await response.json().catch(() => undefined);
    const keys = new Set<string>();
    const collect = (secrets: unknown) => {
      if (!Array.isArray(secrets)) return false;
      for (const secret of secrets) {
        const key = field(secret, "secretKey");
        if (typeof key === "string") keys.add(key);
      }
      return true;
    };
    if (!collect(field(answer, "secrets"))) {
      throw new Error(
        `Infisical at ${baseUrl} answered ${action} without the secrets.`,
      );
    }
    const imports = field(answer, "imports");
    if (Array.isArray(imports)) {
      for (const imported of imports) collect(field(imported, "secrets"));
    }
    return keys;
  };

  const getOne = async (name: string, cwd: string) => {
    const action = `read ${name}`;
    const response = await send(
      secretUrl(name, {
        projectId,
        environment,
        secretPath: folder,
        // The value as it was stored: a PEM or JSON may hold `${`.
        expandSecretReferences: "false",
      }),
      { headers: await authorized(cwd) },
      action,
    );
    // Listed, then deleted before this read.
    if (response.status === 404) return undefined;
    if (!response.ok) throw await refuse(response, action);
    const answer: unknown = await response.json().catch(() => undefined);
    const secret = field(answer, "secret");
    const value = field(secret, "secretValue");
    if (typeof value !== "string") {
      throw new Error(
        `Infisical at ${baseUrl} answered ${action} without its value.`,
      );
    }
    if (field(secret, "secretValueHidden") === true) {
      throw new Error(
        `Infisical at ${baseUrl} hides the value of ${name} from the identity in ${where}: give it a project role that can read secret values.`,
      );
    }
    registerSecretValue(value);
    return value;
  };

  const write = (
    method: "PATCH" | "POST",
    name: string,
    value: string,
    cwd: string,
  ) =>
    authorized(cwd, { "Content-Type": "application/json" }).then((headers) =>
      send(
        secretUrl(name),
        {
          method,
          headers,
          body: JSON.stringify({
            projectId,
            environment,
            secretPath: folder,
            secretValue: value,
            type: "shared",
          }),
        },
        method === "PATCH" ? `update ${name}` : `create ${name}`,
      ),
    );

  return {
    name: "infisical",
    get: async (names, { cwd }) => {
      const unique = [...new Set(names)];
      if (unique.length === 0) return {};
      const held = await listNames(cwd);
      const values = await Promise.all(
        unique.map((name) => (held.has(name) ? getOne(name, cwd) : undefined)),
      );
      // No prototype: a secret may be named __proto__.
      const result: Record<string, string | undefined> = Object.create(null);
      unique.forEach((name, index) => {
        result[name] = values[index];
      });
      return result;
    },
    set: async (name, value, { cwd }) => {
      registerSecretValue(value);
      const updated = await write("PATCH", name, value, cwd);
      if (updated.ok) return;
      if (updated.status !== 404) {
        throw await refuse(updated, `update ${name}`);
      }
      const created = await write("POST", name, value, cwd);
      if (!created.ok) throw await refuse(created, `create ${name}`);
    },
    describe: (name) => `${name} in Infisical ${where}`,
  };
};
