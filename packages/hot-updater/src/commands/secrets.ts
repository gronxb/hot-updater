import fs from "node:fs/promises";
import path from "node:path";

import {
  CREDENTIAL_ENV_NAMES,
  type CredentialKind,
  describeSecret,
  getCwd,
  isSecretName,
  loadConfig,
  nonInteractiveReason,
  p,
  registerCredentialValue,
} from "@hot-updater/cli-tools";

import { printBanner } from "@/utils/printBanner";

import { ui } from "../utils/cli-ui";
import { ensureAscApiKey } from "../utils/native/ascApiKey";
import { CredentialSetupRefusedError } from "../utils/native/issuedCredential";
import { ensurePlayServiceAccount } from "../utils/native/playServiceAccount";

/** The kinds `secrets put` stores, as `secret:` references resolve them. */
export const SECRET_KINDS = [
  "asc-api-key",
  "android-keystore",
  "play-service-account",
] as const satisfies readonly CredentialKind[];

/** Reports a failure with exit code 1, as the server's commands do. */
const reportFailure = async (run: () => Promise<void>) => {
  try {
    await run();
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

export interface SecretsPutOptions {
  readonly kind: CredentialKind;
  /** asc-api-key: the `.p8` file. */
  readonly p8?: string;
  readonly keyId?: string;
  readonly issuerId?: string;
  /** android-keystore: the keystore file. */
  readonly keystore?: string;
  readonly keyAlias?: string;
  /** play-service-account: the service account's JSON key file. */
  readonly serviceAccount?: string;
}

type ValueFlag = Exclude<keyof SecretsPutOptions, "kind">;

/** The flags each kind takes, as `--help` names them. */
const KIND_FLAGS: Readonly<Record<CredentialKind, readonly ValueFlag[]>> = {
  "asc-api-key": ["p8", "keyId", "issuerId"],
  "android-keystore": ["keystore", "keyAlias"],
  "play-service-account": ["serviceAccount"],
};

const FLAG_NAMES: Readonly<Record<ValueFlag, string>> = {
  p8: "--p8 <file>",
  keyId: "--key-id <id>",
  issuerId: "--issuer-id <id>",
  keystore: "--keystore <file>",
  keyAlias: "--key-alias <alias>",
  serviceAccount: "--service-account <file>",
};

const readFile = async (file: string, flag: string) => {
  try {
    return await fs.readFile(path.resolve(file));
  } catch {
    throw new Error(`${flag} does not point to a readable file.`);
  }
};

/** A password from its environment variable, else a hidden prompt. */
const readPassword = async (envName: string, message: string) => {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const reason = nonInteractiveReason();
  if (reason !== undefined) {
    throw new Error(`Set ${envName}: the CLI asks for no password ${reason}.`);
  }
  const answer = await p.password({ message });
  if (p.isCancel(answer) || !answer) {
    throw new Error(`No password was given for ${envName}.`);
  }
  return answer;
};

/**
 * The value `secrets put` stores: one JSON value per credential, as the
 * credential resolver reads it, `{"keyId","issuerId","p8"}` for an App
 * Store Connect key, `{"keystore","storePassword","keyAlias","keyPassword"}`
 * with the keystore in base64, and a service account's own JSON.
 */
const readSecretValue = async (options: SecretsPutOptions): Promise<string> => {
  const { kind } = options;
  const foreign = Object.values(KIND_FLAGS)
    .flat()
    .filter(
      (flag) => !KIND_FLAGS[kind].includes(flag) && options[flag] !== undefined,
    );
  if (foreign.length > 0) {
    throw new Error(
      `A ${kind} takes ${KIND_FLAGS[kind].map((flag) => FLAG_NAMES[flag]).join(", ")}, not ${[...new Set(foreign)].map((flag) => FLAG_NAMES[flag]).join(", ")}.`,
    );
  }
  const required = (flag: ValueFlag) => {
    const value = options[flag];
    if (!value) throw new Error(`A ${kind} needs ${FLAG_NAMES[flag]}.`);
    return value;
  };

  switch (kind) {
    case "asc-api-key": {
      const p8 = (await readFile(required("p8"), "--p8")).toString("utf-8");
      return JSON.stringify({
        keyId: required("keyId"),
        issuerId: required("issuerId"),
        p8,
      });
    }
    case "android-keystore": {
      const keystore = (
        await readFile(required("keystore"), "--keystore")
      ).toString("base64");
      const keyAlias = required("keyAlias");
      return JSON.stringify({
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
      });
    }
    case "play-service-account": {
      const json = (
        await readFile(required("serviceAccount"), "--service-account")
      ).toString("utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          "--service-account is not a service account JSON key file.",
        );
      }
      return json;
    }
  }
};

/** Whether `secrets put` was given any part of a value to store. */
const hasValueFlags = (options: SecretsPutOptions) =>
  Object.values(KIND_FLAGS)
    .flat()
    .some((flag) => options[flag] !== undefined);

/**
 * `secrets put`: stores a build credential as `name` through the config's
 * `secrets` adapter, as one JSON value that `secret:<name>` resolves.
 * Without the key's files, an App Store Connect key or a Play service
 * account is issued after you sign in with your Apple Account or Google.
 */
export const handleSecretsPut = async (
  name: string,
  options: SecretsPutOptions,
): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    if (!isSecretName(name)) {
      throw new Error(
        `"${name}" is no secret name: letters, digits, ".", "_", and "-", starting with a letter or a digit, up to 64 characters.`,
      );
    }
    if (!(SECRET_KINDS as readonly string[]).includes(options.kind)) {
      throw new Error(`--kind is one of ${SECRET_KINDS.join(", ")}.`);
    }
    // Registers the config's secrets adapter, which everything below uses.
    const { secrets, cacheDir } = await loadConfig(null);

    // No key to store: sign in, and Hot Updater issues one.
    const issuedBySignIn =
      options.kind === "asc-api-key"
        ? { label: "App Store Connect API key", ensure: ensureAscApiKey }
        : options.kind === "play-service-account"
          ? { label: "Play service account", ensure: ensurePlayServiceAccount }
          : undefined;
    if (issuedBySignIn && !hasValueFlags(options)) {
      try {
        const result = await issuedBySignIn.ensure({
          name,
          secrets,
          // A read-only adapter's key is written there, with how to store it.
          cacheDir,
          // The adapter is what this stores in, whatever the environment sets.
          environment: false,
        });
        if (result.status === "stored") {
          p.log.message(
            ui.block(`${issuedBySignIn.label} already stored`, [
              ui.kv("Name", name),
              ui.kv("In", describeSecret(secrets, name)),
            ]),
          );
        }
      } catch (error) {
        // canSignIn reported it.
        if (error instanceof CredentialSetupRefusedError) return;
        throw error;
      }
      return;
    }

    if (secrets.set === undefined) {
      throw new Error(
        `The ${secrets.name} secrets adapter is read-only, so Hot Updater stores nothing in it. Set ${describeSecret(secrets, name)} to the ${options.kind} as one JSON value, or set ${CREDENTIAL_ENV_NAMES[options.kind].map((field) => field.join(" or ")).join(", ")}; or configure a secrets adapter that stores values.`,
      );
    }
    const value = await readSecretValue(options);
    // Masked before it is sent, so no failure can print it.
    registerCredentialValue(value);
    await secrets.set(name, value, { cwd: getCwd() });
    p.log.message(
      ui.block("Secret stored", [
        ui.kv("Name", name),
        ui.kv("Kind", options.kind),
        ui.kv("In", describeSecret(secrets, name)),
      ]),
    );
  });
};
