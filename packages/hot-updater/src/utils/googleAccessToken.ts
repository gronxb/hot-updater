import fs from "node:fs/promises";

import { registerSecretValue } from "@hot-updater/cli-tools";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Variables an access token is read from as it is: gcloud's, and the one
 * Terraform's Google provider reads, which a job sets from
 * `google-github-actions/auth`'s `access_token` output.
 */
export const GOOGLE_ACCESS_TOKEN_ENV_NAMES = [
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
] as const;

/** A token is fetched again this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface ExternalAccountCredentials {
  readonly type: "external_account";
  readonly audience: string;
  readonly subject_token_type: string;
  readonly token_url: string;
  readonly service_account_impersonation_url?: string;
  readonly credential_source: {
    readonly url?: string;
    readonly file?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly format?: {
      readonly type?: string;
      readonly subject_token_field_name?: string;
    };
  };
}

interface GoogleAuthClient {
  getAccessToken(): Promise<string | null | undefined>;
}

interface GoogleAuthLibrary {
  GoogleAuth: new (options: { scopes: string[] }) => GoogleAuthClient;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** The fields read from Google's JSON: credentials files and token responses. */
type GoogleJson = Partial<
  Record<
    | "type"
    | "audience"
    | "subject_token_type"
    | "token_url"
    | "workforce_pool_user_project"
    | "credential_source"
    | "url"
    | "file"
    | "executable"
    | "environment_id"
    | "error"
    | "error_description"
    | "status"
    | "message"
    | "access_token"
    | "expires_in"
    | "accessToken"
    | "expireTime",
    unknown
  >
>;

const isRecord = (value: unknown): value is GoogleJson =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const httpsUrl = (url: unknown, what: string): string => {
  let parsed: URL | undefined;
  try {
    parsed = typeof url === "string" ? new URL(url) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "https:") {
    throw new Error(`${what} must be an https URL.`);
  }
  return parsed.href;
};

/**
 * A Workload Identity Federation file whose subject token Hot Updater reads
 * with `fetch`: from a URL, as `google-github-actions/auth` writes it, or a
 * file. Other sources, such as an executable or AWS, go through
 * `google-auth-library`.
 */
const asFetchableExternalAccount = (
  value: unknown,
): ExternalAccountCredentials | undefined => {
  if (
    !isRecord(value) ||
    value.type !== "external_account" ||
    typeof value.audience !== "string" ||
    typeof value.subject_token_type !== "string" ||
    typeof value.token_url !== "string" ||
    value.workforce_pool_user_project !== undefined ||
    !isRecord(value.credential_source)
  ) {
    return undefined;
  }
  const source = value.credential_source;
  const fromUrl = typeof source.url === "string" && source.file === undefined;
  const fromFile = typeof source.file === "string" && source.url === undefined;
  if (
    (!fromUrl && !fromFile) ||
    source.executable !== undefined ||
    source.environment_id !== undefined
  ) {
    return undefined;
  }
  return value as unknown as ExternalAccountCredentials;
};

const readJson = async (response: Response) => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

/** A token endpoint's error, without anything it was sent. */
const tokenError = (what: string, status: number, body: unknown) => {
  const detail = isRecord(body)
    ? (isRecord(body.error)
        ? [body.error.status, body.error.message]
        : [body.error, body.error_description]
      )
        .filter((part) => typeof part === "string" && part)
        .join(": ")
    : "";
  return new Error(
    `${what} failed (${status}${detail ? ` ${detail.slice(0, 300)}` : ""}).`,
  );
};

const readSubjectToken = async (
  credentials: ExternalAccountCredentials,
): Promise<string> => {
  const source = credentials.credential_source;
  let raw: string;
  if (source.url !== undefined) {
    const response = await fetch(
      httpsUrl(source.url, "The Workload Identity Federation token URL"),
      { headers: { ...source.headers }, redirect: "error" },
    );
    if (!response.ok) {
      throw tokenError(
        "Reading the Workload Identity Federation subject token",
        response.status,
        await readJson(response),
      );
    }
    raw = await response.text();
  } else {
    raw = await fs.readFile(source.file as string, "utf8");
  }

  let token: unknown = raw.trim();
  if (source.format?.type === "json") {
    const field = source.format.subject_token_field_name ?? "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      token = isRecord(parsed)
        ? (parsed as Record<string, unknown>)[field]
        : undefined;
    } catch {
      token = undefined;
    }
  }
  if (typeof token !== "string" || !token) {
    throw new Error(
      "The Workload Identity Federation credential source returned no subject token.",
    );
  }
  registerSecretValue(token);
  return token;
};

/**
 * Exchanges a Workload Identity Federation subject token at Google's STS
 * for an access token, and for the service account's when the file names
 * one to impersonate.
 */
const exchangeExternalAccount = async (
  credentials: ExternalAccountCredentials,
): Promise<CachedToken> => {
  const subjectToken = await readSubjectToken(credentials);
  const stsResponse = await fetch(
    httpsUrl(
      credentials.token_url,
      "The Workload Identity Federation token_url",
    ),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: credentials.audience,
        scope: CLOUD_PLATFORM_SCOPE,
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token: subjectToken,
        subject_token_type: credentials.subject_token_type,
      }),
      redirect: "error",
    },
  );
  const sts = await readJson(stsResponse);
  if (
    !stsResponse.ok ||
    !isRecord(sts) ||
    typeof sts.access_token !== "string" ||
    !sts.access_token
  ) {
    throw tokenError(
      "Google's Workload Identity Federation token exchange",
      stsResponse.status,
      sts,
    );
  }
  registerSecretValue(sts.access_token);
  const expiresIn = typeof sts.expires_in === "number" ? sts.expires_in : 0;
  if (credentials.service_account_impersonation_url === undefined) {
    return {
      token: sts.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  const impersonation = await fetch(
    httpsUrl(
      credentials.service_account_impersonation_url,
      "The Workload Identity Federation service_account_impersonation_url",
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${sts.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE] }),
      redirect: "error",
    },
  );
  const impersonated = await readJson(impersonation);
  if (
    !impersonation.ok ||
    !isRecord(impersonated) ||
    typeof impersonated.accessToken !== "string" ||
    !impersonated.accessToken
  ) {
    throw tokenError(
      "Impersonating the Workload Identity Federation service account",
      impersonation.status,
      impersonated,
    );
  }
  registerSecretValue(impersonated.accessToken);
  const expireTime =
    typeof impersonated.expireTime === "string"
      ? Date.parse(impersonated.expireTime)
      : Number.NaN;
  return {
    token: impersonated.accessToken,
    expiresAt: Number.isNaN(expireTime) ? Date.now() : expireTime,
  };
};

const loadGoogleAuthLibrary = async (
  adapterName: string,
): Promise<GoogleAuthLibrary> => {
  try {
    return (await import("google-auth-library")) as unknown as GoogleAuthLibrary;
  } catch {
    throw new Error(
      `${adapterName} reads Application Default Credentials through the optional google-auth-library package. Install it (npm install google-auth-library --save-dev) and sign in with \`gcloud auth application-default login\`, or set ${GOOGLE_ACCESS_TOKEN_ENV_NAMES.join(" or ")} to an access token.`,
    );
  }
};

const readCredentialsFile = async (filePath: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS names ${filePath}, which is no readable JSON credentials file.`,
    );
  }
};

/**
 * Returns a function that resolves a Google Cloud access token with the
 * `cloud-platform` scope, from the first of:
 *
 * 1. `CLOUDSDK_AUTH_ACCESS_TOKEN` or `GOOGLE_OAUTH_ACCESS_TOKEN`, as it is;
 * 2. a Workload Identity Federation file in `GOOGLE_APPLICATION_CREDENTIALS`
 *    whose subject token comes from a URL or a file, as
 *    `google-github-actions/auth` writes it, exchanged with `fetch`;
 * 3. Application Default Credentials through the optional peer
 *    `google-auth-library`, such as `gcloud auth application-default login`
 *    or a service account key file.
 *
 * A token from 2 is kept until a minute before it expires. Each token is
 * masked in the CLI's output.
 */
export const createGoogleAccessToken = (
  adapterName: string,
): (() => Promise<string>) => {
  let cached: CachedToken | undefined;
  let auth: Promise<GoogleAuthClient> | undefined;

  return async () => {
    for (const name of GOOGLE_ACCESS_TOKEN_ENV_NAMES) {
      const token = process.env[name]?.trim();
      if (token) {
        registerSecretValue(token);
        return token;
      }
    }

    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return cached.token;
    }

    const credentialsPath =
      process.env["GOOGLE_APPLICATION_CREDENTIALS"]?.trim();
    if (credentialsPath) {
      const external = asFetchableExternalAccount(
        await readCredentialsFile(credentialsPath),
      );
      if (external) {
        cached = await exchangeExternalAccount(external);
        return cached.token;
      }
    }

    auth ??= loadGoogleAuthLibrary(adapterName)
      .then(
        (library) => new library.GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] }),
      )
      .catch((error: unknown) => {
        auth = undefined;
        throw error;
      });
    const client = await auth;
    let token: string | null | undefined;
    try {
      token = await client.getAccessToken();
    } catch (error) {
      throw new Error(
        `${adapterName} found no Google credentials: sign in with \`gcloud auth application-default login\`, set GOOGLE_APPLICATION_CREDENTIALS, or set ${GOOGLE_ACCESS_TOKEN_ENV_NAMES.join(" or ")} to an access token.`,
        { cause: error },
      );
    }
    if (!token) {
      throw new Error(
        `${adapterName} got no access token from Application Default Credentials.`,
      );
    }
    registerSecretValue(token);
    return token;
  };
};
