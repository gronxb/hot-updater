import {
  authorizeVaultToken,
  type VaultApi,
  type VaultAuditEntry,
  VaultIntegrityError,
  VaultLockedError,
  VaultNotFoundError,
  type VaultSecret,
  type VaultToken,
} from "@hot-updater/server/plugins";

import type { ConsoleRuntime } from "./runtime.server";

/**
 * The vault's HTTP routes, which the console serves under
 * `/_hot-updater/vault/v1/` to CI with a vault token, `Authorization: Bearer
 * hu_vault_...`. They take no session and no client API key, so the console's
 * sign-in never gates them; the token's scope decides what a request reaches.
 * Every response is `Cache-Control: no-store`, and every refusal is
 * `{ error: { code, message } }`:
 * - 401 `unauthorized`: no token, or one that is unknown, revoked, or expired;
 * - 403 `forbidden`: the token's scope does not allow the request;
 * - 400 `invalid_request`: the body is not what the route takes;
 * - 404 `vault_unavailable`: this console serves no vault;
 * - 405 `method_not_allowed`: the route takes another method;
 * - 409 `conflict`: secrets kept changing while a resolve read them;
 * - 503 `vault_locked`: the console has no master key to open values with.
 */

/** What the routes read from the console: its features. */
export type LoadConsole = (
  request: Request,
) => Promise<{ readonly runtime: ConsoleRuntime }>;

/** Names one resolve request takes, as a token's scope lists. */
const MAX_NAMES = 100;
/** Times a resolve lists and authorizes again when a secret changes under it. */
const RESOLVE_ATTEMPTS = 3;
/** `x-hot-updater-ci-run`, as the audit log keeps it. */
const MAX_CI_RUN_LENGTH = 255;

const json = (status: number, body: unknown, headers?: HeadersInit) => {
  const all = new Headers(headers);
  all.set("Cache-Control", "no-store");
  return Response.json(body, { status, headers: all });
};

const failure = (
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
) => json(status, { error: { code, message } }, headers);

const unauthorized = (message: string) =>
  failure(401, "unauthorized", message, {
    "WWW-Authenticate": 'Bearer realm="hot-updater-vault"',
  });

const forbidden = (message: string) => failure(403, "forbidden", message);

const REFUSED_TOKEN = {
  unknown: "The vault token is not one this console issued.",
  revoked: "The vault token was revoked.",
  expired: "The vault token expired.",
} as const;

/** The token in `Authorization: Bearer <token>`, or undefined. */
const bearerOf = (request: Request): string | undefined =>
  /^Bearer +(\S+) *$/iu.exec(request.headers.get("authorization") ?? "")?.[1];

/** The audit context every entry of a request carries. */
const requestContext = (request: Request): Record<string, string> => {
  const run = request.headers.get("x-hot-updater-ci-run")?.trim();
  return run ? { ciRun: run.slice(0, MAX_CI_RUN_LENGTH) } : {};
};

/**
 * The vault and the verified token of a request, or the response that
 * refuses it. The token is checked before anything else is read, and
 * verified with one read by its digest, so a revocation holds from the
 * next request.
 */
const openVault = async (
  request: Request,
  load: LoadConsole,
): Promise<
  Response | { readonly vault: VaultApi; readonly token: VaultToken }
> => {
  const bearer = bearerOf(request);
  if (bearer === undefined) {
    return unauthorized(
      "Send a vault token as Authorization: Bearer hu_vault_..., such as HOT_UPDATER_VAULT_TOKEN.",
    );
  }
  const { runtime } = await load(request);
  if (runtime.remote) {
    return failure(
      404,
      "vault_unavailable",
      "This console reaches a self-hosted server through standaloneRepository, so it serves no vault: the vault's secrets live in the server's database, and only a console over that database opens them. Set the console config's database to the server's database adapter, list vault() in its plugins, and set HOT_UPDATER_VAULT_MASTER_KEY where the console runs.",
    );
  }
  const vault = runtime.apis.vault;
  if (vault === undefined || !(await runtime.features()).vault) {
    return failure(
      404,
      "vault_unavailable",
      'This console runs without the vault() plugin. Add vault() to the plugins of its config (import { vault } from "@hot-updater/server/plugins"), and set HOT_UPDATER_VAULT_MASTER_KEY where the console runs.',
    );
  }
  const verified = await vault.verifyToken({ token: bearer });
  if (!verified.ok) return unauthorized(REFUSED_TOKEN[verified.reason]);
  return { vault, token: verified.token };
};

/** Answers with `respond`, or a 500 when the console cannot serve it. */
const serve = async (respond: () => Promise<Response>) => {
  try {
    return await respond();
  } catch (error) {
    console.error("The vault could not serve a request:", error);
    return failure(500, "internal", "The vault could not serve the request.");
  }
};

/** A method the route does not take, with the one it does in `Allow`. */
export const vaultMethodNotAllowed = (allow: "GET" | "POST") =>
  failure(405, "method_not_allowed", `This route takes ${allow}.`, {
    Allow: allow,
  });

/** Whether `token` may take any of its actions on `secret`. */
const inScope = (token: VaultToken, secret: VaultSecret) =>
  token.scope.actions.some((action) =>
    authorizeVaultToken(token, { action, secret }),
  );

/**
 * `GET /_hot-updater/vault/v1/secrets`: the secrets the token's scope
 * reaches, for any of its actions, without values:
 * `200 { secrets: [{ id, name, kind, version, metadata, createdAtMs, updatedAtMs }] }`.
 */
export const listVaultSecrets = (request: Request, load: LoadConsole) =>
  serve(async () => {
    const opened = await openVault(request, load);
    if (opened instanceof Response) return opened;
    const { vault, token } = opened;
    const secrets = (await vault.list()).filter((secret) =>
      inScope(token, secret),
    );
    await vault.recordAudit({
      entries: [
        {
          actor: token.id,
          action: "list",
          outcome: "allowed",
          context: requestContext(request),
        },
      ],
    });
    return json(200, { secrets });
  });

/** The names a resolve body asks for, deduplicated, or undefined when it is malformed. */
const namesOf = async (request: Request): Promise<string[] | undefined> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  const names =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? Reflect.get(body, "names")
      : undefined;
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.length > MAX_NAMES ||
    !names.every((name) => typeof name === "string")
  ) {
    return undefined;
  }
  return [...new Set(names as string[])];
};

/**
 * `POST /_hot-updater/vault/v1/resolve` with `{ names: string[] }`: the
 * current values of the secrets named, in one request, for a token whose
 * scope allows `read` on each:
 * `200 { secrets: [{ name, kind, version, value }], errors: [{ name, code: "not_found", message }] }`.
 *
 * - A name outside the scope refuses the whole request with 403, whether or
 *   not a secret has it, so a token learns nothing about secrets it cannot
 *   read. A name with no secret is a `not_found` error only when the token's
 *   scope lists it by name.
 * - A `bundle-signing-key` is never resolved, in scope or not: its key
 *   leaves no console, which signs with it at `/_hot-updater/signing`.
 * - Each read, and each refused name, is in the audit log before the
 *   response is sent.
 */
export const resolveVaultSecrets = (request: Request, load: LoadConsole) =>
  serve(async () => {
    const opened = await openVault(request, load);
    if (opened instanceof Response) return opened;
    const { vault, token } = opened;
    const names = await namesOf(request);
    if (names === undefined) {
      return failure(
        400,
        "invalid_request",
        `Send { "names": [...] }, 1-${MAX_NAMES} secret names.`,
      );
    }
    const context = requestContext(request);
    // Each read opens the version its authorization saw; a secret that
    // changed since the list is listed and authorized again.
    for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt += 1) {
      const byName = new Map(
        (await vault.list()).map((secret) => [secret.name, secret]),
      );
      const refuse = async (refused: readonly string[], message: string) => {
        await vault.recordAudit({
          entries: refused.map((name) => {
            const secret = byName.get(name);
            return {
              actor: token.id,
              action: "read",
              ...(secret === undefined ? {} : { secretId: secret.id }),
              outcome: "denied",
              context: { ...context, name },
            } satisfies VaultAuditEntry;
          }),
        });
        return forbidden(message);
      };

      if (!token.scope.actions.includes("read")) {
        return refuse(names, "The vault token's scope does not allow read.");
      }
      const outOfScope = names.filter((name) => {
        const secret = byName.get(name);
        return secret === undefined
          ? !(token.scope.secrets.names?.includes(name) ?? false)
          : !authorizeVaultToken(token, { action: "read", secret });
      });
      if (outOfScope.length > 0) {
        return refuse(
          outOfScope,
          `The vault token's scope does not allow reading ${outOfScope.join(", ")}.`,
        );
      }
      const signingKeys = names.filter(
        (name) => byName.get(name)?.kind === "bundle-signing-key",
      );
      if (signingKeys.length > 0) {
        return refuse(
          signingKeys,
          `${signingKeys.join(", ")} ${signingKeys.length === 1 ? "is a bundle-signing-key" : "are bundle-signing-keys"}, which the vault never resolves: the console signs bundles with them at /_hot-updater/signing, for a token whose scope allows sign.`,
        );
      }

      let read: { name: string; secret?: VaultSecret; value?: unknown }[];
      try {
        read = await Promise.all(
          names.map(async (name) => {
            const secret = byName.get(name);
            if (secret === undefined) return { name };
            const value = await vault.reveal({
              id: secret.id,
              actor: token.id,
              version: secret.version,
            });
            return { name, secret, value };
          }),
        );
      } catch (error) {
        // Rotated, removed, or replaced since the list.
        if (error instanceof VaultNotFoundError) continue;
        if (error instanceof VaultLockedError) {
          return failure(503, "vault_locked", error.message);
        }
        if (error instanceof VaultIntegrityError) {
          console.error("A vault secret did not decrypt:", error);
          return failure(
            500,
            "vault_integrity",
            "A secret's stored value did not decrypt: it was altered, or sealed under another master key.",
          );
        }
        throw error;
      }

      // Values leave only once their reads are in the audit log.
      await vault.recordAudit({
        entries: read.flatMap(({ name, secret }) =>
          secret === undefined
            ? []
            : [
                {
                  actor: token.id,
                  action: "read",
                  secretId: secret.id,
                  outcome: "allowed",
                  context: { ...context, name },
                } satisfies VaultAuditEntry,
              ],
        ),
      });
      return json(200, {
        secrets: read.flatMap(({ name, secret, value }) =>
          secret === undefined
            ? []
            : [{ name, kind: secret.kind, version: secret.version, value }],
        ),
        errors: read.flatMap(({ name, secret }) =>
          secret === undefined
            ? [
                {
                  name,
                  code: "not_found",
                  message: `No secret is named ${name}.`,
                },
              ]
            : [],
        ),
      });
    }
    return failure(
      409,
      "conflict",
      "The secrets changed while they were read; send the request again.",
    );
  });
