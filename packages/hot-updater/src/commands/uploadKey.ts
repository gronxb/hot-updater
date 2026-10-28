import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hasPlayReleases } from "@hot-updater/android-helper";
import {
  credentialIssueCommand,
  describeSecret,
  describeStoredSecret,
  getConfiguredAdapter,
  getCwd,
  getHotUpdaterEnvValue,
  loadConfig,
  nonInteractiveReason,
  p,
  parseSecretReference,
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
  type AndroidKeystoreEntry,
  androidKeystoreValue,
  type CertificateFingerprints,
  createUploadKeystore,
  findKeytool,
  type KeystoreCertificate,
  KeystoreRefusedError,
  listKeystoreAliases,
  parseAndroidKeystoreValue,
  type RunKeytool,
  verifyKeystore,
} from "../utils/native/androidKeystore";
import { offerIssuedKeyToGitHub } from "../utils/native/issuedCredential";
import {
  assertSecretName,
  environmentOverrides,
  listNames,
  reportFailure,
} from "./secrets";

const KIND = "android-keystore";
const LABEL = "Upload key";

/** The SHA-256 on two lines, which fit a row; SHA-1 fits one. */
const fingerprintRows = ({ sha256, sha1 }: CertificateFingerprints) => [
  ui.kv("SHA-256", `${sha256.slice(0, 47)}\n${sha256.slice(48)}`),
  ui.kv("SHA-1", sha1),
];

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Throws for a cancelled prompt. */
const answered = <T>(answer: T | symbol): T => {
  if (p.isCancel(answer)) {
    throw new Error("Setting up the upload key was cancelled.");
  }
  return answer as T;
};

/** Where `secrets` holds `name`, or the environment that overrides it. */
type HeldKey =
  | { readonly status: "environment"; readonly overrides: readonly string[] }
  | {
      readonly status: "stored";
      readonly value: string;
      readonly source: string;
    }
  | { readonly status: "missing" };

/**
 * The adapter the keystore is read from and stored in: the config's own,
 * never a file on this machine under it, so every teammate reads the one
 * key; `localSecrets()`'s store only when the config sets no other.
 */
const keystoreStore = (secrets: SecretsAdapter): SecretsAdapter =>
  getConfiguredAdapter(secrets) ?? secrets;

/** Refuses an adapter that stores nothing, before a key is created or read. */
const assertWritable = (store: SecretsAdapter, name: string) => {
  if (!store.set) {
    throw new Error(
      `The ${store.name} secrets adapter is read-only: add ${name} there.`,
    );
  }
};

const readHeldKey = async (
  secrets: SecretsAdapter,
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<HeldKey> => {
  const overrides = environmentOverrides(KIND, name, secrets, env);
  if (overrides.length > 0) return { status: "environment", overrides };
  const cwd = getCwd();
  const configured = getConfiguredAdapter(secrets);
  let found: { readonly value: string; readonly source: string } | undefined;
  if (configured) {
    const value = (await configured.get([name], { cwd }))[name];
    found =
      typeof value === "string" && value
        ? { value, source: describeSecret(configured, name) }
        : undefined;
  } else {
    found = await readSecretWithSource(secrets, name, cwd);
  }
  if (found === undefined) return { status: "missing" };
  // Masked before anything can print it: only its alias is named.
  registerCredentialValue(found.value);
  return { status: "stored", ...found };
};

/**
 * The rows that name a stored keystore: its alias, and its certificate's
 * fingerprints when keytool opens it with the stored passwords.
 */
const describeStoredKey = async (
  value: string,
): Promise<{
  readonly rows: readonly MaybeRow[];
  readonly certificate?: KeystoreCertificate;
}> => {
  const entry = parseAndroidKeystoreValue(value);
  if (!entry) return { rows: [] };
  const keytool = await findKeytool().catch(() => undefined);
  const certificate = keytool
    ? await verifyKeystore(keytool, entry).catch(() => undefined)
    : undefined;
  return {
    rows: [
      ui.kv("Alias", entry.keyAlias),
      ...(certificate ? fingerprintRows(certificate.fingerprints) : []),
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

/**
 * Stores a keystore's `value` as `name` in `keystoreStore`, and reads it
 * back there: only an exact match counts as stored, so a store that loses
 * or never returns it fails here, not on a teammate's build. No copy is
 * kept on this machine.
 */
const storeUploadKey = async (
  secrets: SecretsAdapter,
  name: string,
  value: string,
): Promise<void> => {
  // Masked before it is sent, so no failure can print it.
  registerCredentialValue(value);
  const store = keystoreStore(secrets);
  assertWritable(store, name);
  const cwd = getCwd();
  try {
    await store.set!(name, value, { cwd });
  } catch (error) {
    throw new Error(
      `The ${store.name} secrets adapter didn't store ${name}.\n${errorText(error)}`,
      { cause: error },
    );
  }
  let held: string | undefined;
  let reason = "It reads back another value.";
  try {
    held = (await store.get([name], { cwd }))[name];
    if (held === undefined) reason = "It reads back nothing.";
  } catch (error) {
    reason = errorText(error);
  }
  if (held !== value) {
    throw new Error(
      [
        `The ${store.name} secrets adapter doesn't read ${name} back as stored.`,
        reason,
        getConfiguredAdapter(secrets)
          ? `Nothing is kept on this machine: check ${describeSecret(store, name)}.`
          : `Check ${describeStoredSecret(secrets, name)}.`,
      ].join("\n"),
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
    schemes.find(
      (candidate) => candidate.signing?.keystore === `secret:${name}`,
    ) ?? schemes[0];
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
  await storeUploadKey(secrets, name, value);
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
    // Refused before a key exists that it could not store.
    assertWritable(keystoreStore(secrets), name);

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

/** A path as typed or dropped on a terminal: quotes, `\ `, and `~` undone. */
const readTypedPath = (typed: string) => {
  const trimmed = typed.trim().replace(/^(['"])(.*)\1$/u, "$2");
  const unescaped = trimmed.replace(/\\ /gu, " ");
  return path.resolve(
    unescaped === "~" || unescaped.startsWith("~/")
      ? path.join(os.homedir(), unescaped.slice(1))
      : unescaped,
  );
};

const isReadableFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
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
 * Asks for the keystore you have, its alias, and its passwords, checks
 * that they open it as Gradle's signing does, and stores it as `name`, the
 * value `secrets put android-keystore` stores.
 */
const importExisting = async (
  secrets: SecretsAdapter,
  name: string,
  keytool: RunKeytool,
) => {
  const file = readTypedPath(
    answered(
      await p.text({
        message: "Keystore file",
        placeholder: "release.keystore",
        validate: (value) =>
          value?.trim() && isReadableFile(readTypedPath(value))
            ? undefined
            : "Enter the path of a keystore file.",
      }),
    ),
  );
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
  await storeUploadKey(secrets, name, value);
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

/**
 * The first of `packageNames` Google Play releases on any track, as the
 * stored Play service account reads it: Play has its upload key. Anything
 * that fails, such as a service account Play has not granted yet, finds
 * nothing.
 */
const findReleasedApp = async (
  secrets: SecretsAdapter,
  env: Readonly<Record<string, string>>,
  packageNames: readonly string[],
): Promise<string | undefined> => {
  if (packageNames.length === 0) return undefined;
  const fetchWithTimeout: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
  try {
    return await withCredentialResolver(
      async (resolver) => {
        const serviceAccount = await resolver.resolve({
          kind: "play-service-account",
        });
        for (const packageName of packageNames) {
          const released = await hasPlayReleases({
            packageName,
            serviceAccount,
            fetch: fetchWithTimeout,
          }).catch(() => false);
          if (released) return packageName;
        }
        return undefined;
      },
      { env, secrets },
    );
  } catch {
    return undefined;
  }
};

/**
 * The upload key step of `google-play login`, after its Play service
 * account: makes sure each keystore a release scheme's `signing.keystore`
 * names, `android-keystore` when none names one, is stored.
 *
 * - A keystore the environment sets, or the adapter holds, is reported
 *   and kept, in CI too.
 * - Without one, at a terminal, it asks whether to create a new upload key
 *   or store the keystore you have, which it suggests when Play already
 *   releases the app. Without a terminal it fails naming both commands.
 */
export const handleGooglePlayUploadKey = async (): Promise<void> => {
  printBanner();
  await reportFailure(async () => {
    const { secrets, nativeBuild } = await loadConfig(null);
    const env = await readLoadedHotUpdaterEnv(getCwd());
    const schemes = androidSchemes(nativeBuild);
    // A debug variant signs with the debug keystore.
    const referenced = [
      ...new Set(
        schemes.flatMap((scheme) =>
          scheme.signing?.keystore && !/debug$/iu.test(scheme.variant ?? "")
            ? [
                parseSecretReference(
                  scheme.signing.keystore,
                  "signing.keystore",
                ),
              ]
            : [],
        ),
      ),
    ];
    const packageNames = [
      ...new Set(
        schemes.map((scheme) => scheme.applicationId ?? scheme.packageName),
      ),
    ];

    for (const name of referenced.length > 0 ? referenced : [KIND]) {
      const held = await readHeldKey(secrets, name, env);
      if (held.status === "environment") {
        reportEnvironment(name, held.overrides, env);
        continue;
      }
      if (held.status === "stored") {
        const { rows } = await describeStoredKey(held.value);
        p.log.step(
          ui.block(`${LABEL} already stored`, [
            name !== KIND && ui.kv("Name", name),
            ...rows,
            ui.kv("Source", ui.fitPath(held.source)),
          ]),
        );
        continue;
      }

      // Refused before a key is created or asked for that it could not store.
      assertWritable(keystoreStore(secrets), name);
      const reason = nonInteractiveReason();
      if (reason !== undefined) {
        throw new Error(
          [
            `Can't set up the upload key ${reason}.`,
            ui.withCommand(
              "Run in a terminal:",
              "npx hot-updater google-play login",
            ),
            ui.withCommand(
              "Or store yours:",
              "npx hot-updater secrets put --help",
            ),
          ].join("\n"),
        );
      }
      // Found before the prompt, so a missing JDK stops nothing half done.
      const keytool = await findKeytool();

      const released = await findReleasedApp(secrets, env, packageNames);
      if (released) {
        p.log.info(
          `${released} is on Play: use the keystore it was signed with.`,
        );
      }
      const choice = answered(
        await p.select<"create" | "existing">({
          message: name === KIND ? LABEL : `${LABEL} (${name})`,
          initialValue: released ? "existing" : "create",
          options: [
            { value: "create", label: "Create a new upload key" },
            { value: "existing", label: "Use my existing keystore" },
          ],
        }),
      );
      if (choice === "existing") {
        await importExisting(secrets, name, keytool);
      } else {
        await createAndStore({
          secrets,
          name,
          commonName: commonNameFor(schemes, name),
        });
      }
    }

    if (referenced.length === 0) {
      p.log.info(
        `Sign builds with it: signing: { keystore: "secret:${KIND}" }`,
      );
    }
  });
};
