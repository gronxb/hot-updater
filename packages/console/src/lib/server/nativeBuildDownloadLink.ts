import { getRequest } from "@tanstack/react-start/server";

import { sameSecret } from "./local-console";

/**
 * How long a signed download link works. A link holds its own expiry and the
 * Console stores nothing, so a new one never ends an older one.
 */
export const NATIVE_BUILD_DOWNLOAD_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The Console's secret, which a hosted Console already has for its sessions:
 * a host's guide lists it. Links sign with a key derived from it, so a link
 * is never a signature the sessions could take, and rotating it ends both.
 */
export const CONSOLE_SECRET_ENV = "BETTER_AUTH_SECRET";

/** The length the Console's deployment guide asks of the secret. */
const MIN_SECRET_LENGTH = 32;

/** Separates the links' key from every other use of the Console's secret. */
const KEY_CONTEXT = "hot-updater/console/signed-links/v1";

/** What a link grants, so a token for anything else never verifies as one. */
const DOWNLOAD_PURPOSE = "native-build-download";

/** `<expiry in Unix seconds>.<HMAC-SHA256, base64url>`. */
const TOKEN_PATTERN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/u;

const encoder = new TextEncoder();

const hmac = async (key: BufferSource, message: string) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      encoder.encode(message),
    ),
  );

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const signatureOf = async (
  secret: string,
  buildId: string,
  expiresAtSeconds: string,
) =>
  base64Url(
    await hmac(
      await hmac(encoder.encode(secret), KEY_CONTEXT),
      `${DOWNLOAD_PURPOSE}\n${buildId}\n${expiresAtSeconds}`,
    ),
  );

/**
 * The Console's secret from the host's environment, or undefined without one
 * long enough to sign with. A Worker's secrets come with the request.
 */
export const readConsoleSecret = (request: Request): string | undefined => {
  const { runtime } = request as Request & {
    readonly runtime?: {
      readonly cloudflare?: { readonly env?: Record<string, unknown> };
    };
  };
  const value =
    runtime?.cloudflare?.env?.[CONSOLE_SECRET_ENV] ??
    (typeof process === "undefined"
      ? undefined
      : process.env[CONSOLE_SECRET_ENV]);
  const secret = typeof value === "string" ? value.trim() : "";
  return secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
};

/** A token that lets its bearer download one build until `expiresAtMs`. */
export const createNativeBuildDownloadToken = async (
  secret: string,
  buildId: string,
  expiresAtMs: number,
): Promise<string> => {
  const expiresAtSeconds = String(Math.floor(expiresAtMs / 1000));
  return `${expiresAtSeconds}.${await signatureOf(secret, buildId, expiresAtSeconds)}`;
};

/**
 * Whether a token lets its bearer download `buildId` now. The expiry counts
 * only under a signature that holds, so `expired` says nothing to a forger.
 */
export const verifyNativeBuildDownloadToken = async (
  secret: string,
  buildId: string,
  token: string,
  now: number = Date.now(),
): Promise<"valid" | "expired" | "invalid"> => {
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) return "invalid";
  const [, expiresAtSeconds, signature] = match as unknown as [
    string,
    string,
    string,
  ];
  // Compares base64url text rather than decoded bytes: a signature's last
  // character carries unused bits, so a changed one could decode the same.
  if (
    !sameSecret(signature, await signatureOf(secret, buildId, expiresAtSeconds))
  ) {
    return "invalid";
  }
  return now >= Number(expiresAtSeconds) * 1000 ? "expired" : "valid";
};

const refusal = (message: string) =>
  new Response(message, {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

/**
 * The 403 for a download link's token, or undefined when it lets its bearer
 * download `buildId`. The answer never repeats the token.
 */
export const refuseNativeBuildDownloadToken = async (
  request: Request,
  buildId: string,
  token: string,
): Promise<Response | undefined> => {
  const secret = readConsoleSecret(request);
  if (secret === undefined) {
    return refusal(
      `This Console can't check download links. Set ${CONSOLE_SECRET_ENV} on it.`,
    );
  }
  switch (await verifyNativeBuildDownloadToken(secret, buildId, token)) {
    case "valid":
      return undefined;
    case "expired":
      return refusal(
        "This download link has expired. Open the build's Console page for a new one.",
      );
    case "invalid":
      return refusal(
        "This download link isn't valid. Open the build's Console page for a new one.",
      );
  }
};

export type NativeBuildDownloadLinkResult =
  | {
      readonly status: "issued";
      /** The `t` query parameter of the build's download route. */
      readonly token: string;
      readonly expiresAt: string;
    }
  /** The local console's lock asks for its session on every route. */
  | { readonly status: "local-console" }
  | { readonly status: "no-secret"; readonly secretName: string };

/**
 * A new signed download link's token, for a caller the Console already let
 * in. It reads nothing and stores nothing.
 */
export const issueNativeBuildDownloadLink = async (
  buildId: string,
  request: Request = getRequest(),
  now: number = Date.now(),
  ttlMs: number = NATIVE_BUILD_DOWNLOAD_LINK_TTL_MS,
): Promise<NativeBuildDownloadLinkResult> => {
  const { default: localConsoleGuard } =
    await import("virtual:hot-updater-console/request-guard");
  if (localConsoleGuard !== undefined) return { status: "local-console" };
  const secret = readConsoleSecret(request);
  if (secret === undefined) {
    return { status: "no-secret", secretName: CONSOLE_SECRET_ENV };
  }
  const expiresAt = now + ttlMs;
  return {
    status: "issued",
    token: await createNativeBuildDownloadToken(secret, buildId, expiresAt),
    expiresAt: new Date(expiresAt).toISOString(),
  };
};
