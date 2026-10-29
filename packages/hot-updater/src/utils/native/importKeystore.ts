import fs from "node:fs/promises";

import {
  describeStoredSecret,
  nonInteractiveReason,
  p,
} from "@hot-updater/cli-tools";
import type { SecretsAdapter } from "@hot-updater/plugin-core";

import { ui } from "../cli-ui";
import { isReadableFile, readTypedPath } from "../typedPath";
import {
  type AndroidKeystoreEntry,
  androidKeystoreValue,
  type CertificateFingerprints,
  findKeytool,
  KeystoreRefusedError,
  listKeystoreAliases,
  type RunKeytool,
  verifyKeystore,
} from "./androidKeystore";
import { offerIssuedKeyToGitHub } from "./issuedCredential";
import { storeCredential } from "./storeCredential";

const KIND = "android-keystore";
const LABEL = "Upload key";

/** The SHA-256 on two lines, which fit a row; SHA-1 fits one. */
export const fingerprintRows = ({ sha256, sha1 }: CertificateFingerprints) => [
  ui.kv("SHA-256", `${sha256.slice(0, 47)}\n${sha256.slice(48)}`),
  ui.kv("SHA-1", sha1),
];

/** Throws for a cancelled prompt. */
const answered = <T>(answer: T | symbol): T => {
  if (p.isCancel(answer)) {
    throw new Error("Setting up the upload key was cancelled.");
  }
  return answer as T;
};

const PASSWORD_ATTEMPTS = 3;

/**
 * Asks for a password until `check` takes it, at most three times, warning
 * about each it refuses for `reason`.
 */
const askPassword = async <T>(
  message: string,
  reason: KeystoreRefusedError["reason"],
  check: (password: string) => Promise<T>,
): Promise<{ readonly password: string; readonly result: T }> => {
  for (let attempt = 1; ; attempt++) {
    const password = answered(
      await p.password({
        message,
        validate: (value) => (value ? undefined : "Enter the password."),
      }),
    );
    try {
      return { password, result: await check(password) };
    } catch (error) {
      if (
        error instanceof KeystoreRefusedError &&
        error.reason === reason &&
        attempt < PASSWORD_ATTEMPTS
      ) {
        p.log.warn(error.message);
        continue;
      }
      throw error;
    }
  }
};

/**
 * The entry `secrets put android-keystore <file> --key-alias <alias>`
 * stores, once its passwords open it as Gradle's signing does. When the
 * key password doesn't unlock the key and the store password does, as in a
 * PKCS12 keystore, which has one password, a terminal asks to use the
 * store password; anywhere else, nothing is stored.
 */
export const checkKeystoreEntry = async (
  entry: AndroidKeystoreEntry,
  keytool?: RunKeytool,
): Promise<AndroidKeystoreEntry> => {
  keytool ??= await findKeytool();
  try {
    await verifyKeystore(keytool, entry);
    return entry;
  } catch (error) {
    if (
      !(error instanceof KeystoreRefusedError) ||
      !error.storePasswordUnlocks ||
      nonInteractiveReason() !== undefined
    ) {
      throw error;
    }
    p.log.warn(error.message);
    const use = answered(
      await p.confirm({
        message: `Use the keystore password for "${entry.keyAlias}"?`,
      }),
    );
    if (!use) throw error;
    return { ...entry, keyPassword: entry.storePassword };
  }
};

/**
 * `secrets put android-keystore <file>` at a terminal: asks for the
 * keystore's alias, unless it holds one key, and its passwords, checks
 * that they open it as Gradle's signing does, and stores it as `name`.
 * The key's password is tried as the store's first: they are often one.
 */
export const importKeystore = async ({
  secrets,
  name,
  file: typed,
  keytool,
}: {
  readonly secrets: SecretsAdapter;
  readonly name: string;
  /** The keystore file, as typed. */
  readonly file: string;
  readonly keytool?: RunKeytool;
}): Promise<void> => {
  const file = readTypedPath(typed);
  if (!isReadableFile(file)) {
    throw new Error(`Can't read the keystore ${ui.fitPath(file)}.`);
  }
  keytool ??= await findKeytool();
  const keystore = await fs.readFile(file);

  const aliases = await listKeystoreAliases(keytool, keystore);
  if (aliases?.length === 0) {
    throw new Error(`${ui.fitPath(file)} holds no private key.`);
  }
  const keyAlias =
    aliases?.length === 1
      ? aliases[0]!
      : aliases
        ? answered(
            await p.select<string>({
              message: "Key alias",
              options: aliases.map((alias) => ({ value: alias, label: alias })),
            }),
          )
        : answered(
            await p.text({
              message: "Key alias",
              validate: (value) =>
                value?.trim() ? undefined : "Enter the key's alias.",
            }),
          ).trim();

  // The key's password is tried as the store's first: they are often one.
  const store = await askPassword(
    "Keystore password",
    "store-password",
    async (password) => {
      const candidate = {
        keystore,
        storePassword: password,
        keyAlias,
        keyPassword: password,
      };
      try {
        return {
          entry: candidate,
          certificate: await verifyKeystore(keytool, candidate),
        };
      } catch (error) {
        if (
          error instanceof KeystoreRefusedError &&
          error.reason === "key-password"
        ) {
          return undefined;
        }
        throw error;
      }
    },
  );
  const { entry, certificate } =
    store.result ??
    (
      await askPassword(
        `Password of the key ${keyAlias}`,
        "key-password",
        async (keyPassword) => {
          const candidate: AndroidKeystoreEntry = {
            keystore,
            storePassword: store.password,
            keyAlias,
            keyPassword,
          };
          return {
            entry: candidate,
            certificate: await verifyKeystore(keytool, candidate),
          };
        },
      )
    ).result;

  const value = androidKeystoreValue(entry);
  await storeCredential(secrets, name, value);
  p.log.success(
    ui.block(`${LABEL} stored`, [
      name !== KIND && ui.kv("Name", name),
      ui.kv("Alias", keyAlias),
      ...fingerprintRows(certificate.fingerprints),
      ui.kv("Source", ui.fitPath(describeStoredSecret(secrets, name))),
    ]),
  );
  await offerIssuedKeyToGitHub({ name, value, secrets });
};
