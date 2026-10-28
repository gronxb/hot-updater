import crypto from "node:crypto";
import http from "node:http";

import { registerSecretValue } from "@hot-updater/cli-tools";

import { type GoogleOAuthClient, PlayServiceAccountError } from "./types";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** How long the browser has to come back with the sign-in. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface GoogleSignIn {
  readonly accessToken: string;
  /** The scopes the account granted, which may be fewer than asked. */
  readonly scopes: readonly string[];
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Hot Updater</title><body style="font-family:system-ui;margin:3rem"><p>${message}</p></body>`;

/**
 * Signs in with Google as an installed app does (RFC 8252): the browser
 * opens Google's own consent screen, so the password and the second factor
 * stay with Google, and the authorization code comes back to a loopback
 * server on 127.0.0.1, bound to a random port for this sign-in only. The
 * code is exchanged with PKCE (S256), and `state` ties the answer to this
 * request.
 *
 * @param onUrl Sees the sign-in URL, to print and open in a browser.
 */
export const signInWithGoogle = async ({
  client,
  scopes,
  onUrl,
  fetch = globalThis.fetch,
  timeoutMs = SIGN_IN_TIMEOUT_MS,
}: {
  client: GoogleOAuthClient;
  scopes: readonly string[];
  onUrl: (url: string) => Promise<void> | void;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<GoogleSignIn> => {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  const state = base64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const { port } = server.address() as { port: number };
    const redirectUri = `http://127.0.0.1:${port}`;
    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new PlayServiceAccountError(
              "sign-in-cancelled",
              "The Google sign-in did not finish in time.",
            ),
          ),
        timeoutMs,
      );
      timer.unref();
      server.on("request", (req, res) => {
        const query = new URL(req.url ?? "/", redirectUri).searchParams;
        // Anything else, such as a favicon, or an answer to another request.
        if (query.get("state") !== state) {
          res.writeHead(404).end();
          return;
        }
        const error = query.get("error");
        const answer = query.get("code");
        res
          .writeHead(error || !answer ? 400 : 200, {
            "content-type": "text/html; charset=utf-8",
          })
          .end(
            page(
              error || !answer
                ? "The sign-in did not finish. Return to the terminal."
                : "Signed in. Close this tab and return to the terminal.",
            ),
          );
        clearTimeout(timer);
        if (error || !answer) {
          reject(
            new PlayServiceAccountError(
              "sign-in-cancelled",
              error === "access_denied"
                ? "The Google sign-in was cancelled."
                : `The Google sign-in failed: ${error ?? "no authorization code"}.`,
            ),
          );
        } else {
          resolve(answer);
        }
      });
    });

    // The browser may answer, or the wait time out, while onUrl still runs.
    code.catch(() => {});

    const url = new URL(AUTHORIZATION_URL);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      prompt: "select_account",
    }).toString();
    await onUrl(url.toString());

    const authorizationCode = await code;
    registerSecretValue(authorizationCode);
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: authorizationCode,
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });
    const token = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      scope?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    if (!response.ok || typeof token.access_token !== "string") {
      throw new PlayServiceAccountError(
        token.error === "invalid_client"
          ? "sign-in-not-configured"
          : "sign-in-cancelled",
        `Google refused the sign-in (HTTP ${response.status}).${typeof token.error_description === "string" ? `\n${token.error_description}` : typeof token.error === "string" ? `\n${token.error}` : ""}`,
      );
    }
    registerSecretValue(token.access_token);
    return {
      accessToken: token.access_token,
      scopes: typeof token.scope === "string" ? token.scope.split(" ") : [],
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

/** Ends a sign-in: Google revokes its access token. Whether Google did. */
export const revokeGoogleToken = async (
  accessToken: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> => {
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
};
