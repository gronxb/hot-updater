import fs from "node:fs/promises";
import path from "node:path";

import {
  credentialIssueCommand,
  describeStoredSecret,
  getConfiguredAdapter,
  getCwd,
  getHotUpdaterEnvValue,
  loadConfig,
  nonInteractiveReason,
  p,
  readLoadedHotUpdaterEnv,
  readSecretWithSource,
  registerCredentialValue,
  withCredentialResolver,
} from "@hot-updater/cli-tools";
import type {
  NativeBuildAndroidScheme,
  SecretsAdapter,
} from "@hot-updater/plugin-core";

import { printBanner } from "@/utils/printBanner";

import { type MaybeRow, ui } from "../utils/cli-ui";
import {
  androidKeystoreValue,
  createUploadKeystore,
  findKeytool,
  type KeystoreCertificate,
  KeystoreRefusedError,
  parseAndroidKeystoreValue,
  verifyKeystore,
} from "../utils/native/androidKeystore";
import { fingerprintRows } from "../utils/native/importKeystore";
import { offerIssuedKeyToGitHub } from "../utils/native/issuedCredential";
import { storeCredential } from "../utils/native/storeCredential";
import {
  assertSecretName,
  environmentOverrides,
  listNames,
  reportFailure,
} from "./secrets";

const KIND = "android-keystore";
const LABEL = "Upload key";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Where `secrets` holds `name`, or the environment that overrides it. */
type HeldKey =
  | { readonly status: "environment"; readonly overrides: readonly string[] }
  | {
      readonly status: "stored";
      readonly value: string;
      readonly source: string;
    }
  | { readonly status: "missing" };

const readHeldKey = async (
  secrets: SecretsAdapter,
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<HeldKey> => {
  const overrides = environmentOverrides(KIND, name, secrets, env);
  if (overrides.length > 0) return { status: "environment", overrides };
  const found = await readSecretWithSource(secrets, name, getCwd());
  if (found === undefined) return { status: "missing" };
  // Masked before anything can print it: only its alias is named.
  registerCredentialValue(found.value);
  return { status: "stored", ...found };
};

/**
 * The rows that name a stored keystore: its alias, and its certificate's
 * fingerprints when its stored passwords open it as Gradle's signing does,
 * else what they don't open.
 */
const describeStoredKey = async (
  value: string,
): Promise<{
  readonly rows: readonly (string | MaybeRow)[];
  readonly certificate?: KeystoreCertificate;
}> => {
  const entry = parseAndroidKeystoreValue(value);
  if (!entry) return { rows: [] };
  const keytool = await findKeytool().catch(() => undefined);
  let refused: string | undefined;
  const certificate = keytool
    ? await verifyKeystore(keytool, entry).catch((error: unknown) => {
        if (error instanceof KeystoreRefusedError) refused = error.message;
        return undefined;
      })
    : undefined;
  return {
    rows: [
      ui.kv("Alias", entry.keyAlias),
      ...(certificate ? fingerprintRows(certificate.fingerprints) : []),
      ...(refused ? refused.split("\n").map((line) => ui.warning(line)) : []),
    ],
    ...(certificate ? { certificate } : {}),
  };
};

const reportEnvironment = (
  name: string,
  overrides: readonly string[],
  env: Readonly<Record<string, string>>,
  pem?: string,
) => {
  const alias = getHotUpdaterEnvValue(env, "HOT_UPDATER_ANDROID_KEY_ALIAS");
  p.log.step(
    ui.block(`${LABEL} set by the environment`, [
      name !== KIND && ui.kv("Name", name),
      alias && ui.kv("Alias", alias),
      // One variable a line: four of them never fit one.
      ui.kv("Source", overrides.join("\n")),
      pem && ui.kv("Certificate", ui.fitPath(path.resolve(pem))),
    ]),
  );
};

/**
 * The certificate of the keystore the environment sets for `name`, read as
 * builds resolve it, from its variables or `localSecrets()`' whole-value
 * variable.
 */
const readEnvironmentCertificate = async (
  secrets: SecretsAdapter,
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<KeystoreCertificate> => {
  const keytool = await findKeytool();
  try {
    return await withCredentialResolver(
      async (resolver) => {
        const keystore = await resolver.resolve({ kind: KIND, name });
        return verifyKeystore(keytool, {
          keystore: await fs.readFile(keystore.storeFile),
          storePassword: keystore.storePassword,
          keyAlias: keystore.keyAlias,
          keyPassword: keystore.keyPassword,
        });
      },
      { env, secrets },
    );
  } catch (error) {
    throw new Error(
      `Can't read ${name}'s certificate from the environment.\n${errorText(error)}`,
      { cause: error },
    );
  }
};

const writePem = async (file: string, certificate: KeystoreCertificate) => {
  try {
    await fs.writeFile(path.resolve(file), certificate.pem);
  } catch (error) {
    throw new Error(`Can't write --pem ${file}: ${errorText(error)}`);
  }
};

/** The certificate's owner: the app the scheme signs, else a generic name. */
const commonNameFor = (
  schemes: readonly NativeBuildAndroidScheme[],
  name: string,
) => {
  const scheme =
    schemes.find((candidate) => candidate.signing?.keystore.name === name) ??
    schemes[0];
  return scheme
    ? (scheme.applicationId ?? scheme.packageName)
    : "Android upload key";
};

const androidSchemes = (
  nativeBuild: { readonly android?: Record<string, unknown> } | undefined,
): NativeBuildAndroidScheme[] =>
  Object.values(nativeBuild?.android ?? {}).filter(
    (scheme): scheme is NativeBuildAndroidScheme => Boolean(scheme),
  );

/**
 * Creates a new upload key with keytool and stores it as `name`, then
 * names its alias, fingerprints, where it is, and the two things only the
 * developer can do: keep a backup, and reset Play's upload key when Play
 * has another.
 */
const createAndStore = async ({
  secrets,
  name,
  commonName,
  pem,
}: {
  readonly secrets: SecretsAdapter;
  readonly name: string;
  readonly commonName: string;
  readonly pem?: string;
}) => {
  const keytool = await findKeytool();
  const { entry, certificate } = await createUploadKeystore(keytool, {
    commonName,
  });
  const value = androidKeystoreValue(entry);
  await storeCredential(secrets, name, value);
  if (pem) await writePem(pem, certificate);
  const configured = getConfiguredAdapter(secrets);
  const pemCommand = `${credentialIssueCommand(KIND, name)} --pem upload.pem`;
  p.log.success(
    ui.block(`${LABEL} created`, [
      name !== KIND && ui.kv("Name", name),
      ui.kv("Alias", entry.keyAlias),
      ...fingerprintRows(certificate.fingerprints),
      ui.kv("Source", ui.fitPath(describeStoredSecret(secrets, name))),
      pem && ui.kv("Certificate", ui.fitPath(path.resolve(pem))),
      "Fits only an app with no .aab on Play yet: Play keeps the first key.",
      configured
        ? `Back it up: ${configured.name} holds your only Play upload key.`
        : "Back up this file: it is your Play upload key.",
      pem
        ? "Play has another upload key? Send this certificate in a key reset."
        : ui.withCommand(
            "Play has another upload key? Request a key reset with:",
            pemCommand,
          ),
    ]),
  );
  await offerIssuedKeyToGitHub({ name, value, secrets });
};

export interface UploadKeyIssueOptions {
  /** Create a new key even when one is stored, which it overwrites. */
  readonly replace?: boolean;
  /** Write the key's certificate, in PEM, to this file. */
  readonly pem?: string;
}

/**
 * `secrets issue android-keystore`: creates a new upload key with the
 * JDK's keytool and stores it as `name` the way issued keys are stored.
 *
 * - A keystore the environment sets is kept: `--replace` refuses until
 *   its variables are unset.
 * - A stored keystore is kept, unless `--replace`: Play rejects builds
 *   signed with another key once it has this one. `--pem` then writes the
 *   stored key's certificate.
 * - It creates a key only at a terminal: a key created in CI, kept on the
 *   runner, would be lost with it.
 */
export const handleUploadKeyIssue = async (
  name: string = KIND,
  { replace = false, pem }: UploadKeyIssueOptions = {},
): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    assertSecretName(name);
    // Registers the config's secrets adapter, which everything below uses.
    const { secrets, nativeBuild } = await loadConfig(null);
    const env = await readLoadedHotUpdaterEnv(getCwd());

    const held = await readHeldKey(secrets, name, env);
    if (held.status === "environment") {
      if (replace) {
        throw new Error(
          `The environment or .env.hotupdater overrides ${KIND}.\nUnset ${listNames(held.overrides)}.`,
        );
      }
      // --pem exports the key builds sign with, wherever it comes from.
      if (pem) {
        await writePem(
          pem,
          await readEnvironmentCertificate(secrets, name, env),
        );
      }
      reportEnvironment(name, held.overrides, env, pem);
      return;
    }
    const previous =
      held.status === "stored"
        ? await describeStoredKey(held.value)
        : undefined;
    if (held.status === "stored" && !replace) {
      if (pem) {
        if (!previous?.certificate) {
          throw new Error(
            `Can't read ${name}'s certificate: keytool can't open the stored keystore.`,
          );
        }
        await writePem(pem, previous.certificate);
      }
      p.log.step(
        ui.block(`${LABEL} already stored`, [
          name !== KIND && ui.kv("Name", name),
          ...(previous?.rows ?? []),
          ui.kv("Source", ui.fitPath(held.source)),
          pem && ui.kv("Certificate", ui.fitPath(path.resolve(pem))),
          !pem && "Kept: once Play has it, a new key breaks uploads.",
        ]),
      );
      return;
    }
    const reason = nonInteractiveReason();
    if (reason !== undefined) {
      throw new Error(
        [
          `Can't create an upload key ${reason}.`,
          ui.withCommand(
            "Run in a terminal:",
            `${credentialIssueCommand(KIND, name)}${replace ? " --replace" : ""}`,
          ),
          ui.withCommand(
            "Or store yours:",
            "npx hot-updater secrets put --help",
          ),
        ].join("\n"),
      );
    }

    await createAndStore({
      secrets,
      name,
      commonName: commonNameFor(androidSchemes(nativeBuild), name),
      ...(pem ? { pem } : {}),
    });
    if (previous) {
      // Its only copy is gone: the fingerprint is what a key reset names.
      p.log.warn(
        ui.block(`The old ${LABEL.toLowerCase()} was replaced`, previous.rows),
      );
    }
  });
};
