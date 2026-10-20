import type { DatabaseJson } from "@hot-updater/plugin-core";

import { VaultInputError, type VaultSecretKind } from "./api";
import { base64ToBytes } from "./crypto";

/**
 * What each kind of secret holds, as the Console stores it and its resolve
 * route returns it. A file is its bytes in base64; key/value kinds map
 * environment variable names to values.
 */
export interface VaultSecretValues {
  /** An App Store Connect API key: the `.p8` file, its key id, and issuer id. */
  readonly "asc-api-key": {
    readonly p8: string;
    readonly keyId: string;
    readonly issuerId: string;
  };
  /** An Android keystore file and what Gradle signs with from it. */
  readonly "android-keystore": {
    readonly keystore: string;
    readonly storePassword: string;
    readonly keyAlias: string;
    readonly keyPassword: string;
  };
  /** A Google Play service account's JSON key file. */
  readonly "play-service-account": { readonly serviceAccount: string };
  /** The RSA private key in PEM that the Console signs bundles with. */
  readonly "bundle-signing-key": { readonly privateKey: string };
  /** Deploy credentials the CLI sets as environment variables. */
  readonly "deploy-credentials": Readonly<Record<string, string>>;
  /** Any other values, by environment variable name. */
  readonly generic: Readonly<Record<string, string>>;
}

export type VaultSecretValue<TKind extends VaultSecretKind = VaultSecretKind> =
  VaultSecretValues[TKind];

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const fieldsOf = (kind: VaultSecretKind, value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VaultInputError(`A secret of kind ${kind} holds a JSON object.`);
  }
  return value as Record<string, unknown>;
};

const text = (kind: VaultSecretKind, fields: Record<string, unknown>) => {
  return (field: string, { trim = true } = {}): string => {
    const value = fields[field];
    if (
      typeof value !== "string" ||
      (trim ? value.trim() : value).length === 0
    ) {
      throw new VaultInputError(`A secret of kind ${kind} needs ${field}.`);
    }
    return trim ? value.trim() : value;
  };
};

/** A base64 file field's text, or null when it is not UTF-8. */
const decodeText = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const file = (
  kind: VaultSecretKind,
  fields: Record<string, unknown>,
  field: string,
): { readonly base64: string; readonly bytes: Uint8Array } => {
  const base64 = text(kind, fields)(field);
  const bytes = base64ToBytes(base64);
  if (bytes === null || bytes.byteLength === 0) {
    throw new VaultInputError(
      `A secret of kind ${kind} has ${field} as a file in base64.`,
    );
  }
  return { base64, bytes };
};

/** A file field whose text must contain a PEM private key. */
const pemFile = (
  kind: VaultSecretKind,
  fields: Record<string, unknown>,
  field: string,
  what: string,
) => {
  const { base64, bytes } = file(kind, fields, field);
  if (
    !/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u.test(decodeText(bytes) ?? "")
  ) {
    throw new VaultInputError(
      `A secret of kind ${kind} has ${field} as ${what}.`,
    );
  }
  return base64;
};

const keyValues = (
  kind: VaultSecretKind,
  value: unknown,
): Readonly<Record<string, string>> => {
  const entries = Object.entries(fieldsOf(kind, value));
  if (entries.length === 0) {
    throw new VaultInputError(
      `A secret of kind ${kind} has at least one variable.`,
    );
  }
  for (const [name, entry] of entries) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new VaultInputError(
        `A variable's name is letters, digits, and underscores, not starting with a digit, and "${name}" is not.`,
      );
    }
    if (typeof entry !== "string") {
      throw new VaultInputError(`The variable ${name} has a text value.`);
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
};

const parsers: {
  readonly [TKind in VaultSecretKind]: (
    value: unknown,
  ) => VaultSecretValues[TKind];
} = {
  "asc-api-key": (value) => {
    const fields = fieldsOf("asc-api-key", value);
    const field = text("asc-api-key", fields);
    return {
      p8: pemFile("asc-api-key", fields, "p8", "a .p8 private key"),
      keyId: field("keyId"),
      issuerId: field("issuerId"),
    };
  },
  "android-keystore": (value) => {
    const fields = fieldsOf("android-keystore", value);
    const field = text("android-keystore", fields);
    return {
      keystore: file("android-keystore", fields, "keystore").base64,
      // Passwords are kept as typed: trimming would change them.
      storePassword: field("storePassword", { trim: false }),
      keyAlias: field("keyAlias"),
      keyPassword: field("keyPassword", { trim: false }),
    };
  },
  "play-service-account": (value) => {
    const fields = fieldsOf("play-service-account", value);
    const { base64, bytes } = file(
      "play-service-account",
      fields,
      "serviceAccount",
    );
    if (serviceAccountOf(bytes) === null) {
      throw new VaultInputError(
        "A secret of kind play-service-account has serviceAccount as a service account's JSON key file.",
      );
    }
    return { serviceAccount: base64 };
  },
  "bundle-signing-key": (value) => {
    const fields = fieldsOf("bundle-signing-key", value);
    return {
      privateKey: pemFile(
        "bundle-signing-key",
        fields,
        "privateKey",
        "a private key in PEM, such as hot-updater keys generate writes",
      ),
    };
  },
  "deploy-credentials": (value) => keyValues("deploy-credentials", value),
  generic: (value) => keyValues("generic", value),
};

/** A service account key file's non-secret fields, or null when it is not one. */
const serviceAccountOf = (
  bytes: Uint8Array,
): { readonly clientEmail: string; readonly projectId?: string } | null => {
  let json: unknown;
  try {
    json = JSON.parse(decodeText(bytes) ?? "");
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const { type, client_email, private_key, project_id } = json as Record<
    string,
    unknown
  >;
  if (
    type !== "service_account" ||
    typeof client_email !== "string" ||
    typeof private_key !== "string"
  ) {
    return null;
  }
  return {
    clientEmail: client_email,
    ...(typeof project_id === "string" ? { projectId: project_id } : {}),
  };
};

/**
 * `value` as a `kind`'s value, with its text fields trimmed but passwords;
 * throws `VaultInputError` naming the field that is missing or malformed.
 */
export const parseVaultSecretValue = <TKind extends VaultSecretKind>(
  kind: TKind,
  value: unknown,
): VaultSecretValues[TKind] => {
  const parse = parsers[kind] as
    | ((value: unknown) => VaultSecretValues[TKind])
    | undefined;
  if (parse === undefined) {
    throw new VaultInputError(`"${String(kind)}" is not a secret kind.`);
  }
  return parse(value);
};

/**
 * What a value shows without its secrets, as the secret's `metadata`: an
 * App Store Connect key's ids, a keystore's alias, a service account's email
 * and project, and a key/value secret's variable names.
 */
export const vaultSecretMetadata = <TKind extends VaultSecretKind>(
  kind: TKind,
  value: VaultSecretValues[TKind],
): Record<string, DatabaseJson> => {
  switch (kind) {
    case "asc-api-key": {
      const { keyId, issuerId } = value as VaultSecretValues["asc-api-key"];
      return { keyId, issuerId };
    }
    case "android-keystore":
      return {
        keyAlias: (value as VaultSecretValues["android-keystore"]).keyAlias,
      };
    case "play-service-account": {
      const bytes = base64ToBytes(
        (value as VaultSecretValues["play-service-account"]).serviceAccount,
      );
      return { ...(bytes === null ? {} : serviceAccountOf(bytes)) };
    }
    case "deploy-credentials":
    case "generic":
      return {
        variables: Object.keys(value as Record<string, string>).sort(),
      };
    default:
      return {};
  }
};
