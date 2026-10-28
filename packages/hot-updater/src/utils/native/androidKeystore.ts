import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerCredentialValue } from "@hot-updater/cli-tools";
import { execa } from "execa";

/** A keystore entry, as an `android-keystore` secret holds it. */
export interface AndroidKeystoreEntry {
  readonly keystore: Buffer;
  readonly storePassword: string;
  readonly keyAlias: string;
  readonly keyPassword: string;
}

/** A certificate's fingerprints, in colon-separated upper-case hex. */
export interface CertificateFingerprints {
  readonly sha256: string;
  readonly sha1: string;
}

/** What a keystore's certificate is, read with keytool. */
export interface KeystoreCertificate {
  readonly fingerprints: CertificateFingerprints;
  /** The certificate in PEM, which Play Console's upload key reset takes. */
  readonly pem: string;
}

/** One keytool run: its arguments, and variables that carry passwords. */
export type RunKeytool = (
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

/** The alias `secrets issue android-keystore` gives a new upload key. */
export const UPLOAD_KEY_ALIAS = "upload";

/** Play takes an upload key of RSA 2048 bits or more, valid past 2033. */
const KEY_SIZE = 4096;
const VALIDITY_DAYS = 10_000;

const STORE_PASSWORD_VARIABLE = "HOT_UPDATER_KEYTOOL_STOREPASS";
const KEY_PASSWORD_VARIABLE = "HOT_UPDATER_KEYTOOL_KEYPASS";

/**
 * The value `secrets put` and `secrets issue` store for a keystore, as the
 * credential resolver reads it: `{"keystore","storePassword","keyAlias",
 * "keyPassword"}`, with the keystore in base64.
 */
export const androidKeystoreValue = (entry: AndroidKeystoreEntry): string =>
  JSON.stringify({
    keystore: entry.keystore.toString("base64"),
    storePassword: entry.storePassword,
    keyAlias: entry.keyAlias,
    keyPassword: entry.keyPassword,
  });

/** The entry an `android-keystore` value holds; undefined for another value. */
export const parseAndroidKeystoreValue = (
  value: string,
): AndroidKeystoreEntry | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const fields = parsed as Record<string, unknown>;
  const [keystore, storePassword, keyAlias, keyPassword] = [
    fields["keystore"],
    fields["storePassword"],
    fields["keyAlias"],
    fields["keyPassword"],
  ];
  if (
    typeof keystore !== "string" ||
    typeof storePassword !== "string" ||
    typeof keyAlias !== "string" ||
    typeof keyPassword !== "string" ||
    !keystore
  ) {
    return undefined;
  }
  return {
    keystore: Buffer.from(keystore, "base64"),
    storePassword,
    keyAlias,
    keyPassword,
  };
};

/** keytool is missing: the message says how to install it. */
export class KeytoolMissingError extends Error {
  constructor() {
    super(
      [
        "keytool is missing: it comes with the JDK that Android builds use.",
        "Install JDK 17 (https://adoptium.net), or set JAVA_HOME to one.",
      ].join("\n"),
    );
    this.name = "KeytoolMissingError";
  }
}

/** The keystore refused what was given for it. */
export class KeystoreRefusedError extends Error {
  readonly reason: "store-password" | "alias" | "key-password" | "unreadable";

  constructor(reason: KeystoreRefusedError["reason"], message: string) {
    super(message);
    this.name = "KeystoreRefusedError";
    this.reason = reason;
  }
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";

/**
 * The JDK's keytool, as Gradle finds the JDK: `JAVA_HOME`'s, else the one on
 * `PATH`. A keytool that does not run, such as macOS's `/usr/bin/keytool`
 * without a JDK, counts as missing.
 */
export const findKeytool = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunKeytool> => {
  const javaHome = env["JAVA_HOME"];
  const candidates = [
    ...(javaHome
      ? [
          path.join(
            javaHome,
            "bin",
            process.platform === "win32" ? "keytool.exe" : "keytool",
          ),
        ]
      : []),
    "keytool",
  ];
  for (const candidate of candidates) {
    const run = createKeytool(candidate);
    const probe = await run(["-help"]).catch(() => undefined);
    if (probe?.exitCode === 0) return run;
  }
  throw new KeytoolMissingError();
};

/** Runs `file` as keytool, in English, with no input: it never prompts. */
export const createKeytool =
  (file: string): RunKeytool =>
  async (args, env = {}) => {
    const result = await execa(file, ["-J-Duser.language=en", ...args], {
      reject: false,
      stdin: "ignore",
      env,
    });
    if (result.failed && result.exitCode === undefined) {
      throw new KeytoolMissingError();
    }
    return {
      exitCode: result.exitCode ?? 1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  };

/** Runs `use` with `keystore` written to a private directory it then deletes. */
const withKeystoreFile = async <T>(
  keystore: Buffer | undefined,
  use: (file: string) => Promise<T>,
): Promise<T> => {
  // mkdtemp creates the directory for this user only (0700).
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-keystore-"),
  );
  const file = path.join(directory, "upload.keystore");
  try {
    if (keystore) await fs.writeFile(file, keystore, { mode: 0o600 });
    return await use(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

const colonHex = (digest: Buffer) =>
  [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();

/** The fingerprints of a certificate keytool printed in PEM. */
const readCertificate = (pem: string): KeystoreCertificate => {
  const base64 = pem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (!base64) {
    throw new KeystoreRefusedError(
      "unreadable",
      "keytool printed no certificate.",
    );
  }
  const der = Buffer.from(base64, "base64");
  return {
    fingerprints: {
      sha256: colonHex(crypto.createHash("sha256").update(der).digest()),
      sha1: colonHex(crypto.createHash("sha1").update(der).digest()),
    },
    pem: `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
};

const exportCertificate = async (
  keytool: RunKeytool,
  file: string,
  {
    storePassword,
    keyAlias,
  }: Omit<AndroidKeystoreEntry, "keystore" | "keyPassword">,
): Promise<KeystoreCertificate> => {
  const result = await keytool(
    [
      "-exportcert",
      "-rfc",
      "-alias",
      keyAlias,
      "-keystore",
      file,
      "-storepass:env",
      STORE_PASSWORD_VARIABLE,
    ],
    { [STORE_PASSWORD_VARIABLE]: storePassword },
  );
  if (result.exitCode !== 0) {
    const reason = firstLine(`${result.stderr}\n${result.stdout}`);
    if (/password was incorrect|keystore password/iu.test(reason)) {
      throw new KeystoreRefusedError(
        "store-password",
        "The keystore password is wrong.",
      );
    }
    if (/alias .* does not exist/iu.test(reason)) {
      throw new KeystoreRefusedError(
        "alias",
        `The keystore has no key ${keyAlias}.`,
      );
    }
    throw new KeystoreRefusedError(
      "unreadable",
      `keytool can't read the keystore: ${reason.replace(/^keytool error:\s*/u, "")}`,
    );
  }
  return readCertificate(result.stdout);
};

/**
 * The certificate of `entry`'s key, after checking that both passwords open
 * it, as Gradle's signing does: the store password reads the certificate,
 * and a certificate request, which signs with the key, needs the key
 * password. Throws `KeystoreRefusedError` naming what is wrong.
 */
export const verifyKeystore = (
  keytool: RunKeytool,
  entry: AndroidKeystoreEntry,
): Promise<KeystoreCertificate> => {
  registerCredentialValue(androidKeystoreValue(entry));
  return withKeystoreFile(entry.keystore, async (file) => {
    const certificate = await exportCertificate(keytool, file, entry);
    const request = await keytool(
      [
        "-certreq",
        "-alias",
        entry.keyAlias,
        "-keystore",
        file,
        "-storepass:env",
        STORE_PASSWORD_VARIABLE,
        "-keypass:env",
        KEY_PASSWORD_VARIABLE,
      ],
      {
        [STORE_PASSWORD_VARIABLE]: entry.storePassword,
        [KEY_PASSWORD_VARIABLE]: entry.keyPassword,
      },
    );
    if (request.exitCode !== 0) {
      throw new KeystoreRefusedError(
        "key-password",
        `The password of the key ${entry.keyAlias} is wrong.`,
      );
    }
    return certificate;
  });
};

/**
 * The aliases of the keystore's private keys, which keytool lists without
 * its password; undefined when keytool can't read it.
 */
export const listKeystoreAliases = async (
  keytool: RunKeytool,
  keystore: Buffer,
): Promise<string[] | undefined> =>
  withKeystoreFile(keystore, async (file) => {
    const result = await keytool(["-list", "-v", "-keystore", file]);
    if (result.exitCode !== 0) return undefined;
    const aliases: string[] = [];
    let alias: string | undefined;
    for (const line of result.stdout.split("\n")) {
      const name = /^Alias name:\s*(.+)$/u.exec(line.trim());
      if (name) alias = name[1]!.trim();
      if (alias && /^Entry type:\s*PrivateKeyEntry/u.test(line.trim())) {
        aliases.push(alias);
        alias = undefined;
      }
    }
    return aliases;
  });

/** Characters keytool's `-dname` reads as syntax, escaped. */
const escapeDistinguishedName = (value: string) =>
  value.replace(/[,+="\\<>;]/gu, (character) => `\\${character}`);

/**
 * A new upload key: an RSA 4096 key valid for 10000 days, as alias
 * `upload`, in a PKCS12 keystore with a random password that exists only in
 * memory and the value returned. PKCS12 has one password for the store and
 * its keys, so `keyPassword` is the store password. `commonName`, such as
 * the app's application ID, names the certificate's owner.
 */
export const createUploadKeystore = async (
  keytool: RunKeytool,
  { commonName }: { readonly commonName: string },
): Promise<{
  readonly entry: AndroidKeystoreEntry;
  readonly certificate: KeystoreCertificate;
}> => {
  const password = crypto.randomBytes(24).toString("base64url");
  registerCredentialValue(password);
  return withKeystoreFile(undefined, async (file) => {
    const result = await keytool(
      [
        "-genkeypair",
        "-noprompt",
        "-keystore",
        file,
        "-storetype",
        "PKCS12",
        "-alias",
        UPLOAD_KEY_ALIAS,
        "-keyalg",
        "RSA",
        "-keysize",
        String(KEY_SIZE),
        "-validity",
        String(VALIDITY_DAYS),
        "-dname",
        `CN=${escapeDistinguishedName(commonName)}`,
        "-storepass:env",
        STORE_PASSWORD_VARIABLE,
        "-keypass:env",
        STORE_PASSWORD_VARIABLE,
      ],
      { [STORE_PASSWORD_VARIABLE]: password },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `keytool couldn't create the keystore: ${firstLine(`${result.stderr}\n${result.stdout}`).replace(/^keytool error:\s*/u, "")}`,
      );
    }
    const entry: AndroidKeystoreEntry = {
      keystore: await fs.readFile(file),
      storePassword: password,
      keyAlias: UPLOAD_KEY_ALIAS,
      keyPassword: password,
    };
    return {
      entry,
      certificate: await exportCertificate(keytool, file, entry),
    };
  });
};
