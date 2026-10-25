import {
  ASC_INTEGRATIONS_URL,
  type IssueAscApiKey,
  type IssuedAscApiKey,
  issueAscApiKey,
} from "@hot-updater/apple-helper";
import {
  CREDENTIAL_ENV_NAMES,
  createVaultClient,
  getHotUpdaterEnvValue,
  p,
  resolveVaultConnection,
  VAULT_CONNECTION_ENV_NAMES,
  type VaultClient,
  VaultRequestError,
} from "@hot-updater/cli-tools";

import { ui } from "../cli-ui";
import { canPrompt } from "../prompt";

/** The command that signs in once, in a terminal, and stores the key. */
export const ascApiKeySetupCommand = (name: string) =>
  `npx hot-updater secrets put ${name} --kind asc-api-key`;

/**
 * Why there is no App Store Connect API key to sign or upload with, already
 * reported by `canPrompt`, which set the exit code.
 */
export class AscApiKeyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AscApiKeyRefusedError";
  }
}

/**
 * The key was issued but not stored. `revoked` says whether it was revoked
 * again, so nothing is left behind; when it is false, the message names the
 * key to revoke in App Store Connect.
 */
export class AscApiKeyNotStoredError extends Error {
  readonly keyId: string;
  readonly revoked: boolean;
  constructor(
    message: string,
    keyId: string,
    revoked: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AscApiKeyNotStoredError";
    this.keyId = keyId;
    this.revoked = revoked;
  }
}

/**
 * The role of every key Hot Updater issues. A team key can't carry the
 * per-user "Access to Cloud Managed Distribution Certificate" permission, so
 * Xcode's cloud-managed signing (`-allowProvisioningUpdates` with
 * `-authenticationKey*`) works only with an Admin key; Developer and App
 * Manager keys fail it. Admin also uploads builds to TestFlight. EAS and asc
 * both default to it.
 */
const KEY_ROLE = "ADMIN";

export type EnsureAscApiKeyResult =
  /** The environment overrides the key: nothing is looked up in the vault. */
  | { readonly status: "environment" }
  /** The vault holds the key already: no sign-in. */
  | { readonly status: "stored"; readonly version: number }
  /** The key was issued with an Apple Account sign-in and stored. */
  | {
      readonly status: "issued";
      readonly keyId: string;
      readonly version: number;
    };

/**
 * Whether the vault token may write `name` as an asc-api-key, asked without
 * storing anything: the Console checks a write's scope before its value, so
 * a write of an empty asc-api-key value is refused with 400 when the token
 * may write it and 403 when it may not. A 403 is logged as a denied write.
 */
const assertWritable = async (client: VaultClient, name: string) => {
  try {
    await client.put({
      name,
      kind: "asc-api-key",
      value: {},
      expectedVersion: 0,
    });
  } catch (error) {
    if (!(error instanceof VaultRequestError)) throw error;
    if (error.status === 400 && error.code === "invalid_request") return;
    if (error.status === 403) {
      throw new Error(
        `The vault token cannot store ${name}, which keeps the key Hot Updater issues after you sign in with your Apple Account. Use a vault token whose scope allows write on ${name} (hot-updater secrets token create --actions read,write), so you sign in only once.`,
        { cause: error },
      );
    }
    if (error.status === 404 || error.status === 405) {
      throw new Error(
        `The Console at ${client.url} does not store secrets from the CLI: upgrade it, then run this again.`,
        { cause: error },
      );
    }
    throw error;
  }
  // The Console never stores an empty value; reaching here means it did.
  throw new Error(
    `The Console at ${client.url} accepted an empty ${name}: remove it in the Console, then run this again.`,
  );
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Makes sure an App Store Connect API key named `name` exists where builds
 * resolve it, issuing one when it does not. Everything that can fail is
 * checked before any Apple sign-in, in this order:
 *
 * 1. an environment override of asc-api-key (`HOT_UPDATER_ASC_KEY*`) is
 *    used as it is;
 * 2. a vault secret named `name` of kind asc-api-key is used as it is, so
 *    CI builds with the stored key and never signs in;
 * 3. without a terminal, it refuses with the command that signs in once;
 * 4. the vault token must be allowed to store `name`.
 *
 * Only then does the developer sign in with their Apple Account, through
 * `issue`, and the issued key is stored, read back, and revoked with the
 * same session if storing it fails. The vault is the only place a key is stored: the
 * environment overrides are read, never written.
 */
export const ensureAscApiKey = async ({
  name,
  bundleIdentifier,
  env = {},
  environment = true,
  issue = issueAscApiKey,
}: {
  /** The vault secret builds resolve, `asc-api-key` unless `signing.ascApiKey` names another. */
  name: string;
  /** The app the key is named after in App Store Connect. */
  bundleIdentifier?: string;
  /** Environment values read after `process.env`, such as `.env.hotupdater`'s. */
  env?: Readonly<Record<string, string>>;
  /** An environment override of asc-api-key counts as the key. */
  environment?: boolean;
  /** How the key is issued after the Apple Account signs in. */
  issue?: IssueAscApiKey;
}): Promise<EnsureAscApiKeyResult> => {
  const overrides = CREDENTIAL_ENV_NAMES["asc-api-key"]
    .flat()
    .filter((variable) => getHotUpdaterEnvValue(env, variable) !== undefined);
  if (environment && overrides.length > 0) {
    return { status: "environment" };
  }

  // Read as the build's credential resolver reads it, with .env.hotupdater.
  const connection = await resolveVaultConnection({ env });
  if (!connection.ok) {
    throw new Error(
      `${name} is an App Store Connect API key, which Hot Updater issues when you sign in with your Apple Account and keeps in the Console's vault, and ${connection.missing.join(" and ")} ${connection.missing.length === 1 ? "is" : "are"} not set. Set ${VAULT_CONNECTION_ENV_NAMES.url} and ${VAULT_CONNECTION_ENV_NAMES.token} (a token that may write ${name}), or set ${CREDENTIAL_ENV_NAMES["asc-api-key"].map((field) => field[0]).join(", ")} to use a key you already have.`,
    );
  }
  const client = createVaultClient(connection.connection);
  const existing = (await client.list()).find((secret) => secret.name === name);
  if (existing?.kind === "asc-api-key") {
    return { status: "stored", version: existing.version };
  }
  if (existing) {
    throw new Error(
      `The vault's ${name} is a ${existing.kind}, not an asc-api-key: name the key differently with signing.ascApiKey, or remove ${name} in the Console.`,
    );
  }

  if (
    !canPrompt(
      `${name} is not in the vault yet. Hot Updater issues it when you sign in with your Apple Account, which needs a terminal.`,
      `Run \`${ascApiKeySetupCommand(name)}\` in a terminal once, and builds use the stored key, also`,
    )
  ) {
    throw new AscApiKeyRefusedError(
      `${name} is not in the vault, and there is no terminal to sign in with an Apple Account.`,
    );
  }

  await assertWritable(client, name);
  // Read is not asked here: a token scoped by kind may read a secret only
  // once it exists. A token that cannot read the stored key fails the
  // build's resolve after it, and the key stays stored for the next run.

  const appleId = await p.text({
    message: "Apple Account (email) to sign in to App Store Connect with",
    validate: (value) =>
      value?.trim() ? undefined : "Enter the Apple Account's email.",
  });
  if (p.isCancel(appleId)) {
    throw new AscApiKeyRefusedError(
      "Signing in with an Apple Account was cancelled.",
    );
  }

  const key = await issue({
    name: `hot-updater ${bundleIdentifier ?? name} ${today()}`,
    role: KEY_ROLE,
    appleId: appleId.trim(),
    chooseTeam: async (team) => {
      const label = team.developerTeamId ?? team.teamId;
      if (!label) return undefined;
      const same = await p.confirm({
        message: `Create the key in the team ${label}${team.appleId ? ` (${team.appleId})` : ""}?`,
      });
      if (p.isCancel(same)) {
        throw new AscApiKeyRefusedError("Creating the key was cancelled.");
      }
      if (same) return undefined;
      const other = await p.text({
        message:
          "The team ID to create the key in, as App Store Connect shows it",
        validate: (value) =>
          value?.trim() ? undefined : "Enter the team's ID.",
      });
      if (p.isCancel(other)) {
        throw new AscApiKeyRefusedError("Creating the key was cancelled.");
      }
      return other.trim();
    },
  });
  try {
    const version = await storeKey(client, name, key);
    p.log.success(
      ui.block("App Store Connect API key stored", [
        ui.kv("Secret", name),
        ui.kv("Key ID", key.keyId),
        ui.kv("Issuer ID", key.issuerId),
        ui.kv("Version", ui.version(`v${version}`)),
      ]),
    );
    return { status: "issued", keyId: key.keyId, version };
  } catch (error) {
    // The one-time key is not kept anywhere: revoke it with the session it
    // was issued in, so no key is left that nothing holds.
    const revoked = await key.revoke().catch(() => false);
    const reason = error instanceof Error ? error.message : String(error);
    throw new AscApiKeyNotStoredError(
      revoked
        ? `The App Store Connect API key ${key.keyId} was not stored, so it was revoked again: ${reason}`
        : `The App Store Connect API key ${key.keyId} was not stored, and revoking it failed: revoke ${key.keyId} at ${ASC_INTEGRATIONS_URL}. ${reason}`,
      key.keyId,
      revoked,
      { cause: error },
    );
  } finally {
    await key.dispose();
  }
};

/**
 * Stores `key` as the vault's `name`, never over a key someone stored
 * meanwhile, and reads it back: the version written, as an asc-api-key with
 * the key's IDs. Returns the version.
 */
const storeKey = async (
  client: VaultClient,
  name: string,
  key: IssuedAscApiKey,
): Promise<number> => {
  const secret = await client.put({
    name,
    kind: "asc-api-key",
    value: {
      p8: Buffer.from(key.p8, "utf-8").toString("base64"),
      keyId: key.keyId,
      issuerId: key.issuerId,
    },
    expectedVersion: 0,
  });
  const listed = (await client.list()).find(
    (candidate) => candidate.name === name,
  );
  if (
    listed?.kind !== "asc-api-key" ||
    listed.version !== secret.version ||
    listed.metadata["keyId"] !== key.keyId ||
    listed.metadata["issuerId"] !== key.issuerId
  ) {
    throw new Error(`The vault does not list ${name} as the key just stored.`);
  }
  return secret.version;
};
