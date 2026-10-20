import {
  createBundleSigningHandler,
  REMOTE_BUNDLE_SIGNING_TOKEN_HEADER,
} from "@hot-updater/plugin-core";
import {
  authorizeVaultToken,
  parseVaultSecretValue,
  VAULT_SECRET_KINDS,
  type VaultApi,
  type VaultAuditEntry,
  type VaultSecret,
  type VaultSecretKind,
  vaultSecretMetadata,
  type VaultToken,
} from "@hot-updater/server/plugins";

import {
  type BundleSigningKey,
  BundleSigningKeyError,
  openBundleSigningKey,
} from "./bundleSigningKey";
import type { ConsoleRuntime } from "./runtime.server";

/**
 * Whether `error` is the vault's error `name`. Told by name, not class: the
 * vault in the console's config can be another copy of the package than
 * the one the console bundles, such as a config `hot-updater console`
 * loads from the project, whose classes are not these.
 */
const isVaultError = (
  error: unknown,
  name:
    | "VaultConflictError"
    | "VaultInputError"
    | "VaultIntegrityError"
    | "VaultLockedError"
    | "VaultNotFoundError",
): error is Error => error instanceof Error && error.name === name;

/**
 * The vault's HTTP routes, which the console serves under
 * `/_hot-updater/vault/v1/` to CI with a vault token, `Authorization: Bearer
 * hu_vault_...`. They take no session and no client API key, so the console's
 * sign-in never gates them; the token's scope decides what a request reaches.
 * Every response is `Cache-Control: no-store`, and every refusal is
 * `{ error: { code, message } }`:
 * - 401 `unauthorized`: no token, or one that is unknown, revoked, or expired;
 * - 403 `forbidden`: the token's scope does not allow the request;
 * - 400 `invalid_request`: the name or body is not what the route takes;
 * - 404 `vault_unavailable`: this console serves no vault;
 * - 405 `method_not_allowed`: the route takes another method;
 * - 409 `conflict`: secrets kept changing while a resolve read them, or a
 *   write met a secret of another kind, or a newer version;
 * - 503 `vault_locked`: the console has no master key to open values with,
 *   or its master keys are not the vault's.
 *
 * The console also signs bundles at `/_hot-updater/signing`, the remote
 * signing protocol, for a vault token sent as its signing token: see
 * `serveVaultSigning`.
 */

/** What the routes read from the console: its features. */
export type LoadConsole = (
  request: Request,
) => Promise<{ readonly runtime: ConsoleRuntime }>;

/** Names one resolve request takes, as a token's scope lists. */
const MAX_NAMES = 100;
/** A secret name, as the vault takes one: what a resolve may ask for and the audit log records. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
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

type OpenedVault =
  | Response
  | { readonly vault: VaultApi; readonly token: VaultToken };

/**
 * The vault and the verified token of a request, or the response that
 * refuses it. The token is checked before anything else is read, and
 * verified with one read by its digest, so a revocation holds from the
 * next request.
 */
const openVault = async (
  request: Request,
  load: LoadConsole,
): Promise<OpenedVault> => {
  const bearer = bearerOf(request);
  if (bearer === undefined) {
    return unauthorized(
      "Send a vault token as Authorization: Bearer hu_vault_..., such as HOT_UPDATER_VAULT_TOKEN.",
    );
  }
  return openVaultWith(request, bearer, load, unauthorized);
};

/** `openVault` for a token the request presented, refused with `refuse`. */
const openVaultWith = async (
  request: Request,
  presented: string,
  load: LoadConsole,
  refuse: (message: string) => Response,
): Promise<OpenedVault> => {
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
  const verified = await vault.verifyToken({ token: presented });
  if (!verified.ok) return refuse(REFUSED_TOKEN[verified.reason]);
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

/** The 500 for a secret whose stored value does not decrypt. */
const integrityFailure = (error: unknown) => {
  console.error("A vault secret did not decrypt:", error);
  return failure(
    500,
    "vault_integrity",
    "A secret's stored value did not decrypt: it was altered, or sealed under another master key.",
  );
};

/** A method the route does not take, with the one it does in `Allow`. */
export const vaultMethodNotAllowed = (allow: "GET" | "POST" | "PUT") =>
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
    !names.every((name) => typeof name === "string" && NAME_PATTERN.test(name))
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
        `Send { "names": [...] }, 1-${MAX_NAMES} secret names, each 1-64 letters, digits, dots, dashes, or underscores.`,
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
        if (isVaultError(error, "VaultNotFoundError")) continue;
        if (isVaultError(error, "VaultLockedError")) {
          return failure(503, "vault_locked", error.message);
        }
        if (isVaultError(error, "VaultIntegrityError")) {
          return integrityFailure(error);
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

/** A kind with its article, such as "an asc-api-key". */
const aKind = (kind: string) =>
  `${/^[aeiou]/u.test(kind) ? "an" : "a"} ${kind}`;

/** The `{ kind, value, expectedVersion? }` a write body holds, or undefined when it is malformed. */
const writeOf = async (
  request: Request,
): Promise<
  | {
      readonly kind: VaultSecretKind;
      readonly value: unknown;
      readonly expectedVersion?: number;
    }
  | undefined
> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const kind = Reflect.get(body, "kind");
  if (!VAULT_SECRET_KINDS.includes(kind as VaultSecretKind)) return undefined;
  const expectedVersion: unknown = Reflect.get(body, "expectedVersion");
  if (
    expectedVersion !== undefined &&
    !(Number.isSafeInteger(expectedVersion) && (expectedVersion as number) >= 0)
  ) {
    return undefined;
  }
  return {
    kind: kind as VaultSecretKind,
    value: Reflect.get(body, "value"),
    ...(expectedVersion === undefined
      ? {}
      : { expectedVersion: expectedVersion as number }),
  };
};

/**
 * `PUT /_hot-updater/vault/v1/secrets/:name` with `{ kind, value }`: stores
 * `value` as the secret's next version, creating the secret when no secret
 * has the name, for a token whose scope allows `write` on it, by its name or
 * its kind, and on the secret it replaces. The console seals the value with
 * its master key, so plaintext reaches it only over this request, and
 * answers with the secret's metadata, never a value:
 * `201 { secret }` for a new secret, `200 { secret }` for a new version.
 *
 * - `value` is the kind's shape, as the console's Vault page stores it,
 *   files in base64; the console derives the secret's metadata from it.
 * - `write` reads nothing back, and a `bundle-signing-key` may be written,
 *   such as one `hot-updater keys generate` made, though it is never
 *   resolved.
 * - A name or kind outside the scope is refused with 403, whether or not a
 *   secret has the name, and so is replacing a secret the scope does not
 *   reach. A secret of another kind under the name is a 409, and so is one
 *   at another version than an optional `expectedVersion`: 0 stores only a
 *   new secret, as `hot-updater keys generate --vault` does.
 * - Each write is in the audit log in the write's own transaction, and each
 *   one the scope refuses before the response is sent.
 */
export const putVaultSecret = (
  request: Request,
  name: string,
  load: LoadConsole,
) =>
  serve(async () => {
    const opened = await openVault(request, load);
    if (opened instanceof Response) return opened;
    const { vault, token } = opened;
    if (!NAME_PATTERN.test(name)) {
      return failure(
        400,
        "invalid_request",
        "A secret name is 1-64 letters, digits, dots, dashes, or underscores, starting with a letter or digit.",
      );
    }
    const write = await writeOf(request);
    if (write === undefined) {
      return failure(
        400,
        "invalid_request",
        `Send { "kind", "value" }, with kind one of ${VAULT_SECRET_KINDS.join(", ")}, and optionally "expectedVersion", 0 or more.`,
      );
    }
    const context = { ...requestContext(request), name };
    const existing = (await vault.list()).find(
      (secret) => secret.name === name,
    );
    if (
      !authorizeVaultToken(token, {
        action: "write",
        secret: { name, kind: write.kind },
      }) ||
      (existing !== undefined &&
        !authorizeVaultToken(token, { action: "write", secret: existing }))
    ) {
      await vault.recordAudit({
        entries: [
          {
            actor: token.id,
            action: "write",
            ...(existing === undefined ? {} : { secretId: existing.id }),
            outcome: "denied",
            context,
          },
        ],
      });
      return forbidden(
        token.scope.actions.includes("write")
          ? `The vault token's scope does not allow writing ${name} as ${write.kind}.`
          : "The vault token's scope does not allow write.",
      );
    }
    if (existing !== undefined && existing.kind !== write.kind) {
      return failure(
        409,
        "conflict",
        `The secret "${name}" is ${aKind(existing.kind)}; remove it in the console before storing ${aKind(write.kind)} under its name.`,
      );
    }
    if (
      write.expectedVersion !== undefined &&
      write.expectedVersion !== (existing?.version ?? 0)
    ) {
      return failure(
        409,
        "conflict",
        existing === undefined
          ? `No secret is named "${name}", and the write expected version ${write.expectedVersion}.`
          : `The secret "${name}" is at version ${existing.version}, and the write expected ${write.expectedVersion === 0 ? "no secret under its name" : `version ${write.expectedVersion}`}.`,
      );
    }

    let value: unknown;
    try {
      value = parseVaultSecretValue(write.kind, write.value);
    } catch (error) {
      if (isVaultError(error, "VaultInputError")) {
        return failure(400, "invalid_request", error.message);
      }
      throw error;
    }
    let secret: VaultSecret;
    try {
      secret = await vault.put({
        name,
        kind: write.kind,
        value,
        metadata: vaultSecretMetadata(write.kind, value as never),
        expectedVersion: write.expectedVersion ?? existing?.version ?? 0,
        // In the write's transaction: logged exactly when it is stored.
        audit: { actor: token.id, context },
      });
    } catch (error) {
      if (isVaultError(error, "VaultConflictError")) {
        return failure(
          409,
          "conflict",
          `${error.message} Send the request again to store the next version.`,
        );
      }
      if (isVaultError(error, "VaultLockedError")) {
        return failure(503, "vault_locked", error.message);
      }
      if (isVaultError(error, "VaultInputError")) {
        return failure(400, "invalid_request", error.message);
      }
      throw error;
    }
    return json(existing === undefined ? 201 : 200, { secret });
  });

/**
 * `GET` and `POST /_hot-updater/signing`: the remote bundle signing protocol
 * of `remoteSigning` from `hot-updater/signing`, served with a vault
 * `bundle-signing-key`, whose private key never leaves the console. The
 * vault token is the protocol's signing token, sent as
 * `x-hot-updater-signing-token`, such as `HOT_UPDATER_SIGNING_TOKEN`, and its
 * scope must allow `sign` on exactly one bundle signing key, the one the
 * console signs with: scope a token by name to pick a key among several.
 *
 * - The token is verified, and the key chosen, before the key is opened;
 *   `GET` opens it for its public key, and `POST` signs one 32-byte message.
 * - Each signature is in the audit log as an allowed `sign` before it is
 *   sent, and a verified token whose scope reaches no single key as a denied
 *   one. Public key requests are not logged.
 * - Refusals are the vault's `{ error: { code, message } }`, and the
 *   protocol's own, such as a malformed body, are its `{ error }`.
 */
export const serveVaultSigning = (request: Request, load: LoadConsole) =>
  serve(async () => {
    const presented = request.headers.get(REMOTE_BUNDLE_SIGNING_TOKEN_HEADER);
    if (!presented) {
      return failure(
        401,
        "unauthorized",
        `Send a vault token whose scope allows sign as ${REMOTE_BUNDLE_SIGNING_TOKEN_HEADER}, such as remoteSigning's HOT_UPDATER_SIGNING_TOKEN.`,
      );
    }
    const context = requestContext(request);
    // The vault's refusal of the request, which replaces the protocol's.
    let refusal: Response | undefined;
    let signer:
      | {
          readonly vault: VaultApi;
          readonly token: VaultToken;
          readonly secret: VaultSecret;
        }
      | undefined;
    let key: BundleSigningKey | undefined;

    // A failure no refusal names is logged, and answered as the vault's 500.
    const failClosed = <T>(run: () => Promise<T>) =>
      run().catch((error: unknown) => {
        console.error("The vault could not serve a signing request:", error);
        refusal = failure(
          500,
          "internal",
          "The vault could not serve the request.",
        );
        throw error;
      });

    const response = await createBundleSigningHandler({
      request,
      token: (token) =>
        failClosed(async () => {
          const opened = await openVaultWith(request, token, load, (message) =>
            failure(401, "unauthorized", message),
          );
          if (opened instanceof Response) {
            refusal = opened;
            return false;
          }
          const { vault } = opened;
          const keys = (await vault.list()).filter(
            (secret) =>
              secret.kind === "bundle-signing-key" &&
              authorizeVaultToken(opened.token, { action: "sign", secret }),
          );
          if (keys.length !== 1) {
            await vault.recordAudit({
              entries: [
                {
                  actor: opened.token.id,
                  action: "sign",
                  outcome: "denied",
                  context: {
                    ...context,
                    ...(keys.length > 1
                      ? { names: keys.map(({ name }) => name) }
                      : {}),
                  },
                },
              ],
            });
            refusal = forbidden(
              keys.length > 1
                ? `The vault token may sign with ${keys.map(({ name }) => name).join(", ")}: scope a sign token to one bundle-signing-key by name, the key the console signs with.`
                : opened.token.scope.actions.includes("sign")
                  ? "The vault token's scope allows sign on no bundle-signing-key."
                  : "The vault token's scope does not allow sign.",
            );
            return false;
          }
          signer = { vault, token: opened.token, secret: keys[0]! };
          return true;
        }),
      publicKey: async () => {
        const { vault, token, secret } = signer!;
        try {
          key = await openBundleSigningKey(
            await vault.reveal({
              id: secret.id,
              actor: token.id,
              version: secret.version,
            }),
          );
        } catch (error) {
          refusal = isVaultError(error, "VaultLockedError")
            ? failure(503, "vault_locked", error.message)
            : isVaultError(error, "VaultNotFoundError")
              ? failure(
                  409,
                  "conflict",
                  `The bundle signing key ${secret.name} changed while the console opened it; send the request again.`,
                )
              : isVaultError(error, "VaultIntegrityError")
                ? integrityFailure(error)
                : error instanceof BundleSigningKeyError
                  ? failure(
                      500,
                      "invalid_signing_key",
                      `The bundle signing key ${secret.name} ${error.message}; overwrite it with the key hot-updater keys generate makes.`,
                    )
                  : undefined;
          if (refusal === undefined) {
            console.error(
              "The vault could not open a bundle signing key:",
              error,
            );
          }
          throw error;
        }
        return key.publicKey;
      },
      sign: async (message) => {
        const { vault, token, secret } = signer!;
        try {
          const signature = await key!.sign(message);
          // A signature leaves only once it is in the audit log.
          await vault.recordAudit({
            entries: [
              {
                actor: token.id,
                action: "sign",
                secretId: secret.id,
                outcome: "allowed",
                context: { ...context, name: secret.name },
              },
            ],
          });
          return signature;
        } catch (error) {
          console.error("The vault could not sign a bundle:", error);
          refusal = failure(
            500,
            "internal",
            "The vault could not serve the request.",
          );
          throw error;
        }
      },
    });
    return (
      refusal ?? response ?? failure(404, "not_found", "No route matches.")
    );
  });
