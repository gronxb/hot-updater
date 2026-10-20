import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  p,
  registerSecretValue,
  type VaultClient,
  type VaultSecretMetadata,
} from "@hot-updater/cli-tools";
import {
  VAULT_SECRET_KINDS,
  type VaultApi,
  type VaultSecretKind,
  type VaultToken,
  type VaultTokenAction,
} from "@hot-updater/server/plugins";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import { connectVault, resolveVaultVariables } from "../vaultEnv";
import {
  confirmAction,
  requirePlugin,
  withPluginServer,
} from "./utils/open-server";

const VAULT = {
  id: "vault",
  call: "vault()",
  importLine: 'import { vault } from "hot-updater/plugins"',
  serverImportLine: 'import { vault } from "@hot-updater/server/plugins"',
} as const;

/** Reports a failure with exit code 1, as the server's commands do. */
const reportFailure = async (run: () => Promise<void>) => {
  try {
    await run();
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

/** Runs `run` over the Console's vault, which the connection variables reach. */
const withConsoleVault = (
  wanted: string,
  run: (client: VaultClient) => Promise<void>,
) => reportFailure(() => run(connectVault(wanted)));

const formatSecrets = (secrets: readonly VaultSecretMetadata[]): string => {
  if (secrets.length === 0) return ui.muted("(no secrets)");
  return ui.table(
    [
      { key: "name", label: "Name" },
      { key: "kind", label: "Kind", format: ui.muted },
      { key: "version", label: "Version", format: ui.version },
      { key: "updated", label: "Updated", format: ui.muted },
    ],
    secrets.map((secret) => ({
      name: secret.name,
      kind: secret.kind,
      version: String(secret.version),
      updated: new Date(secret.updatedAtMs).toISOString(),
    })),
  );
};

export interface SecretsListOptions {
  readonly json?: boolean;
}

/** `secrets list`: the secrets the vault token reaches, without values. */
export const handleSecretsList = async (
  options: SecretsListOptions = {},
): Promise<void> => {
  if (!options.json) printBanner();
  await withConsoleVault("hot-updater secrets list reads", async (client) => {
    const secrets = await client.list();
    if (options.json) {
      console.log(JSON.stringify(secrets, null, 2));
    } else {
      p.log.message(formatSecrets(secrets));
    }
  });
};

export interface SecretsPutOptions {
  readonly kind: VaultSecretKind;
  /** asc-api-key: the `.p8` file. */
  readonly p8?: string;
  readonly keyId?: string;
  readonly issuerId?: string;
  /** android-keystore: the keystore file. */
  readonly keystore?: string;
  readonly keyAlias?: string;
  /** play-service-account: the service account's JSON key file. */
  readonly serviceAccount?: string;
  /** bundle-signing-key: the private key PEM file. */
  readonly privateKey?: string;
  /** deploy-credentials and generic: `NAME=value`, or `NAME` to copy it from the environment. */
  readonly variables?: readonly string[];
}

/** The flags each kind takes, as `--help` names them. */
const KIND_FLAGS: Readonly<
  Record<VaultSecretKind, readonly (keyof SecretsPutOptions)[]>
> = {
  "asc-api-key": ["p8", "keyId", "issuerId"],
  "android-keystore": ["keystore", "keyAlias"],
  "play-service-account": ["serviceAccount"],
  "bundle-signing-key": ["privateKey"],
  "deploy-credentials": ["variables"],
  generic: ["variables"],
};

const FLAG_NAMES: Readonly<Record<string, string>> = {
  p8: "--p8 <file>",
  keyId: "--key-id <id>",
  issuerId: "--issuer-id <id>",
  keystore: "--keystore <file>",
  keyAlias: "--key-alias <alias>",
  serviceAccount: "--service-account <file>",
  privateKey: "--private-key <file>",
  variables: "NAME=value or NAME arguments",
};

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const readBase64File = async (file: string, flag: string) => {
  try {
    return (await fs.readFile(path.resolve(file))).toString("base64");
  } catch {
    throw new Error(`${flag} does not point to a readable file.`);
  }
};

/** A password from its environment variable, else a hidden prompt. */
const readPassword = async (envName: string, message: string) => {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      `Set ${envName}: there is no terminal to ask for the password in.`,
    );
  }
  const answer = await p.password({ message });
  if (p.isCancel(answer) || !answer) {
    throw new Error(`No password was given for ${envName}.`);
  }
  return answer;
};

const readVariables = (
  entries: readonly string[] | undefined,
): Record<string, string> => {
  if (!entries || entries.length === 0) {
    throw new Error(
      "Pass the variables to store as NAME=value, or NAME to copy one from the environment.",
    );
  }
  const variables: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const name = separator === -1 ? entry : entry.slice(0, separator);
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(
        `"${name}" is no variable name: letters, digits, and underscores, not starting with a digit.`,
      );
    }
    const value =
      separator === -1 ? process.env[name] : entry.slice(separator + 1);
    if (value === undefined) {
      throw new Error(`${name} is not set in the environment to copy.`);
    }
    variables[name] = value;
  }
  return variables;
};

/** The value `secrets put` stores, in the shape the Console takes for its kind. */
const readSecretValue = async (
  options: SecretsPutOptions,
): Promise<Record<string, string>> => {
  const { kind } = options;
  if (!VAULT_SECRET_KINDS.includes(kind)) {
    throw new Error(`--kind is one of ${VAULT_SECRET_KINDS.join(", ")}.`);
  }
  const foreign = Object.entries(KIND_FLAGS)
    .filter(([other]) => other !== kind)
    .flatMap(([, flags]) => flags)
    .filter(
      (flag) =>
        !KIND_FLAGS[kind].includes(flag) &&
        (flag === "variables"
          ? (options.variables?.length ?? 0) > 0
          : options[flag] !== undefined),
    );
  if (foreign.length > 0) {
    throw new Error(
      `A ${kind} takes ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}, not ${[...new Set(foreign)].map((flag) => FLAG_NAMES[flag]).join(", ")}.`,
    );
  }
  const required = (
    flag:
      | "p8"
      | "keyId"
      | "issuerId"
      | "keystore"
      | "keyAlias"
      | "serviceAccount"
      | "privateKey",
  ) => {
    const value = options[flag];
    if (!value) throw new Error(`A ${kind} needs ${FLAG_NAMES[flag]}.`);
    return value;
  };

  switch (kind) {
    case "asc-api-key":
      return {
        p8: await readBase64File(required("p8"), "--p8"),
        keyId: required("keyId"),
        issuerId: required("issuerId"),
      };
    case "android-keystore": {
      const keystore = await readBase64File(required("keystore"), "--keystore");
      const keyAlias = required("keyAlias");
      return {
        keystore,
        storePassword: await readPassword(
          "HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD",
          "Keystore password",
        ),
        keyAlias,
        keyPassword: await readPassword(
          "HOT_UPDATER_ANDROID_KEY_PASSWORD",
          `Password of the key ${keyAlias}`,
        ),
      };
    }
    case "play-service-account":
      return {
        serviceAccount: await readBase64File(
          required("serviceAccount"),
          "--service-account",
        ),
      };
    case "bundle-signing-key":
      return {
        privateKey: await readBase64File(
          required("privateKey"),
          "--private-key",
        ),
      };
    case "deploy-credentials":
    case "generic":
      return readVariables(options.variables);
  }
};

/** The fields of a value that are no secret: ids and aliases, which the Console lists as metadata. */
const PUBLIC_FIELDS = new Set(["keyId", "issuerId", "keyAlias"]);
/** The file fields whose contents are text, such as a PEM. */
const TEXT_FILE_FIELDS = new Set(["p8", "serviceAccount", "privateKey"]);

/**
 * `secrets put`: stores a secret's next version through the Console, which
 * seals it with its master key; the token's scope must allow `write` on it.
 */
export const handleSecretsPut = async (
  name: string,
  options: SecretsPutOptions,
): Promise<void> => {
  printBanner();
  await withConsoleVault(
    `hot-updater secrets put stores ${name}`,
    async (client) => {
      const value = await readSecretValue(options);
      // Masked before it is sent, so no failure can print it.
      for (const [field, entry] of Object.entries(value)) {
        if (PUBLIC_FIELDS.has(field)) continue;
        registerSecretValue(entry);
        if (TEXT_FILE_FIELDS.has(field)) {
          registerSecretValue(Buffer.from(entry, "base64").toString("utf-8"));
        }
      }
      const secret = await client.put({ name, kind: options.kind, value });
      p.log.message(
        ui.block("Secret stored", [
          ui.kv("Name", secret.name),
          ui.kv("Kind", secret.kind),
          // As v1: a short value just stored, such as 1, is masked alone.
          ui.kv("Version", ui.version(`v${secret.version}`)),
        ]),
      );
    },
  );
};

/**
 * `secrets env -- <command>`: runs `command` with the variables of the
 * `deploy-credentials` and `generic` secrets the token reaches, each one
 * already set (not empty) in the environment kept as it is, and exits with
 * its code.
 */
export const handleSecretsEnv = async (
  command: readonly string[],
): Promise<void> => {
  await withConsoleVault("hot-updater secrets env reads", async (client) => {
    const [file, ...args] = command;
    if (file === undefined) {
      throw new Error("Pass the command to run after --.");
    }
    const variables = await resolveVaultVariables(client);
    // A variable set in the environment wins; an empty one counts as unset,
    // as vaultEnv reads it.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [name, value] of Object.entries(variables)) {
      if (!env[name]?.trim()) env[name] = value;
    }
    const outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const child = spawn(file, args, { env, stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    if (outcome.signal) {
      process.kill(process.pid, outcome.signal);
      return;
    }
    process.exitCode = outcome.code ?? 1;
  });
};

export interface SecretsTokenCommandOptions {
  /** The server definition the command line names, such as `src/hotUpdater.ts`. */
  readonly serverPath?: string;
}

export interface SecretsTokenCreateOptions extends SecretsTokenCommandOptions {
  readonly name: string;
  readonly secrets?: readonly string[];
  readonly kinds?: readonly string[];
  readonly actions: readonly string[];
  readonly expiresInDays?: number;
}

export interface SecretsTokenListOptions extends SecretsTokenCommandOptions {
  readonly json?: boolean;
}

export interface SecretsTokenRevokeOptions extends SecretsTokenCommandOptions {
  readonly yes?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The actions the Console serves a token, as its Tokens tab offers them. */
const ISSUED_ACTIONS: readonly VaultTokenAction[] = ["read", "write"];

/**
 * Runs `run` over the vault() the server runs, in process: tokens need no
 * master key, and the CLI's vault reveals nothing.
 */
const withVaultTokens = (
  options: SecretsTokenCommandOptions,
  run: (vault: VaultApi) => Promise<void>,
): Promise<void> =>
  withPluginServer(options.serverPath, async (server) => {
    // standaloneRepository's plugins run on the server, whose admin API
    // serves no vault routes.
    if (server.api === undefined) {
      throw new Error(
        "Vault tokens live in the database the Console opens, and hot-updater.config.ts reaches the server through standaloneRepository's admin API, which serves no vault. Run hot-updater secrets token <command> <path-to-server-definition> where the database is reachable, or use a hot-updater.config.ts whose database is the server's adapter.",
      );
    }
    requirePlugin(server, VAULT);
    await run(server.api[VAULT.id] as VaultApi);
  });

const describeScope = (token: VaultToken) =>
  [
    ...(token.scope.secrets.names ?? []),
    ...(token.scope.secrets.kinds ?? []).map((kind) => `kind:${kind}`),
  ].join(", ");

const statusOf = (token: VaultToken, now: number) =>
  token.revokedAtMs !== null
    ? "revoked"
    : token.expiresAtMs !== null && token.expiresAtMs <= now
      ? "expired"
      : "active";

const formatTokens = (tokens: readonly VaultToken[]): string => {
  if (tokens.length === 0) return ui.muted("(no vault tokens)");
  const now = Date.now();
  return ui.table(
    [
      { key: "id", label: "ID", format: ui.id },
      { key: "name", label: "Name" },
      { key: "prefix", label: "Prefix", format: ui.muted },
      { key: "secrets", label: "Secrets" },
      { key: "actions", label: "Actions" },
      {
        key: "status",
        label: "Status",
        format: (value: string) =>
          value.trim() === "active" ? ui.success(value) : ui.danger(value),
      },
      { key: "expires", label: "Expires", format: ui.muted },
    ],
    tokens.map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      secrets: describeScope(token),
      actions: token.scope.actions.join(", "),
      status: statusOf(token, now),
      expires:
        token.expiresAtMs === null
          ? "never"
          : new Date(token.expiresAtMs).toISOString(),
    })),
  );
};

/** `secrets token create`: issues a vault token and prints it once. */
export const handleSecretsTokenCreate = async (
  options: SecretsTokenCreateOptions,
): Promise<void> => {
  printBanner();
  const unserved = options.actions.filter(
    (action) => !ISSUED_ACTIONS.includes(action as VaultTokenAction),
  );
  if (unserved.length > 0) {
    p.log.error(
      `--actions takes ${ISSUED_ACTIONS.join(" and ")}, the actions the Console serves a vault token, not ${unserved.join(", ")}.`,
    );
    process.exitCode = 1;
    return;
  }
  await withVaultTokens(options, async (vault) => {
    const issued = await vault.issueToken({
      name: options.name,
      scope: {
        secrets: {
          ...(options.secrets?.length ? { names: options.secrets } : {}),
          ...(options.kinds?.length
            ? { kinds: options.kinds as VaultSecretKind[] }
            : {}),
        },
        actions: options.actions as VaultTokenAction[],
      },
      ...(options.expiresInDays === undefined
        ? {}
        : { expiresAtMs: Date.now() + options.expiresInDays * DAY_MS }),
    });
    p.log.message(
      ui.block("Vault token created", [
        ui.kv("Name", issued.metadata.name),
        ui.kv("ID", ui.id(issued.metadata.id)),
        ui.kv("Secrets", describeScope(issued.metadata)),
        ui.kv("Actions", issued.metadata.scope.actions.join(", ")),
        ui.kv(
          "Expires",
          issued.metadata.expiresAtMs === null
            ? "never"
            : new Date(issued.metadata.expiresAtMs).toISOString(),
        ),
        ui.kv("Token", ui.warning(issued.token)),
      ]),
    );
    p.log.warn(
      "Save this token now, such as in CI's HOT_UPDATER_VAULT_TOKEN. It will not be shown again.",
    );
  });
};

/** `secrets token list`: every vault token, newest first, without its plaintext. */
export const handleSecretsTokenList = async (
  options: SecretsTokenListOptions = {},
): Promise<void> => {
  if (!options.json) printBanner();
  await withVaultTokens(options, async (vault) => {
    const tokens = await vault.listTokens();
    if (options.json) {
      console.log(JSON.stringify(tokens, null, 2));
    } else {
      p.log.message(formatTokens(tokens));
    }
  });
};

/** `secrets token revoke`: revokes a vault token at once. */
export const handleSecretsTokenRevoke = async (
  id: string,
  options: SecretsTokenRevokeOptions = {},
): Promise<void> => {
  printBanner();
  if (!(await confirmAction(`Revoke vault token ${id}?`, options.yes))) return;
  await withVaultTokens(options, async (vault) => {
    const revoked = await vault.revokeToken({ id });
    if (revoked === null) {
      throw new Error(`Vault token "${id}" was not found.`);
    }
    p.log.message(
      ui.block("Vault token revoked", [
        ui.kv("Name", revoked.name),
        ui.kv("ID", ui.id(revoked.id)),
      ]),
    );
  });
};
