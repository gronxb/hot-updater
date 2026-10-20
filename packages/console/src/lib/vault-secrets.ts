import type {
  VaultSecretKind,
  VaultSecretValues,
  VaultToken,
  VaultTokenAction,
} from "@hot-updater/server/plugins";

/**
 * The vault's kinds, in the order the console offers them. The vault's own
 * list stays on the server; a spec keeps the two equal.
 */
export const VAULT_SECRET_KIND_IDS = [
  "asc-api-key",
  "android-keystore",
  "play-service-account",
  "bundle-signing-key",
  "deploy-credentials",
  "generic",
] as const satisfies readonly VaultSecretKind[];

/** How the console offers one token action. */
export interface VaultTokenActionUi {
  readonly label: string;
  /**
   * The secrets it applies to: reading never returns a bundle signing key,
   * signing uses only those, and writing stores any secret.
   */
  readonly reaches: "values" | "signing-keys" | "all";
}

/**
 * What the console offers for each token action the vault defines. It is
 * keyed by the vault's action type, so a new action fails to compile until
 * it is described here, and a spec keeps the keys equal to the vault's
 * list. Null marks an action the console does not serve, which it never
 * offers. `sign` signs bundles at the console's `/_hot-updater/signing`
 * with a bundle signing key, and `write` may store one, such as one
 * `hot-updater keys generate --vault` made, which reading never returns.
 */
export const vaultTokenActions: Readonly<
  Record<VaultTokenAction, VaultTokenActionUi | null>
> = {
  read: { label: "Read values", reaches: "values" },
  sign: { label: "Sign bundles", reaches: "signing-keys" },
  write: { label: "Write values", reaches: "all" },
};

/**
 * Whether a token taking `actions` reaches secrets of `kind`. Without an
 * action chosen, every kind but bundle signing keys, as reading reaches.
 */
export const actionsReachKind = (
  actions: readonly VaultTokenAction[],
  kind: VaultSecretKind,
): boolean => {
  const signingKey = kind === "bundle-signing-key";
  if (actions.length === 0) return !signingKey;
  return actions.some((action) => {
    const reaches = vaultTokenActions[action]?.reaches;
    return (
      reaches === "all" ||
      (reaches === "signing-keys" && signingKey) ||
      (reaches === "values" && !signingKey)
    );
  });
};

/** The actions a token the console issues may take, in the vault's order. */
export const OFFERED_TOKEN_ACTIONS = (
  Object.keys(vaultTokenActions) as VaultTokenAction[]
).filter((action) => vaultTokenActions[action] !== null);

/** A value's limit in UTF-8 JSON bytes, as the vault enforces it. */
export const VAULT_VALUE_LIMIT_BYTES = 64 * 1024;

/** One input of a kind's form; a file is sent as its bytes in base64. */
export interface VaultSecretField {
  readonly key: string;
  readonly label: string;
  readonly type: "file" | "text" | "password";
  /** The file picker's `accept`. */
  readonly accept?: string;
  readonly placeholder?: string;
  readonly description?: string;
}

export interface VaultSecretKindUi {
  readonly label: string;
  /** What uses it, under the kind picker. */
  readonly description: string;
  /** Its fields, or null for variables by environment variable name. */
  readonly fields: readonly VaultSecretField[] | null;
}

export const vaultSecretKinds: {
  readonly [TKind in VaultSecretKind]: VaultSecretKindUi;
} = {
  "asc-api-key": {
    label: "App Store Connect API key",
    description: "Signs iOS builds and uploads them to TestFlight.",
    fields: [
      {
        key: "p8",
        label: "Private key (.p8)",
        type: "file",
        accept: ".p8",
        description: "The AuthKey_<key ID>.p8 file App Store Connect gave you.",
      },
      {
        key: "keyId",
        label: "Key ID",
        type: "text",
        placeholder: "ABC123DEFG",
      },
      {
        key: "issuerId",
        label: "Issuer ID",
        type: "text",
        placeholder: "00000000-0000-0000-0000-000000000000",
      },
    ],
  },
  "android-keystore": {
    label: "Android keystore",
    description: "Signs Android release builds.",
    fields: [
      {
        key: "keystore",
        label: "Keystore file",
        type: "file",
        accept: ".jks,.keystore,.p12",
      },
      { key: "storePassword", label: "Store password", type: "password" },
      {
        key: "keyAlias",
        label: "Key alias",
        type: "text",
        placeholder: "upload",
      },
      { key: "keyPassword", label: "Key password", type: "password" },
    ],
  },
  "play-service-account": {
    label: "Google Play service account",
    description: "Uploads Android builds to Google Play.",
    fields: [
      {
        key: "serviceAccount",
        label: "Service account key (.json)",
        type: "file",
        accept: ".json,application/json",
      },
    ],
  },
  "bundle-signing-key": {
    label: "Bundle signing key",
    description:
      "The private key OTA bundles are signed with. The vault never sends it to CI.",
    fields: [
      {
        key: "privateKey",
        label: "Private key (.pem)",
        type: "file",
        accept: ".pem,.key",
        description:
          "keys/private-key.pem, from npx hot-updater keys generate.",
      },
    ],
  },
  "deploy-credentials": {
    label: "Deploy credentials",
    description: "Environment variables the CLI deploys with.",
    fields: null,
  },
  generic: {
    label: "Generic",
    description: "Any other environment variables your scripts read.",
    fields: null,
  },
};

/** The JSON a value takes in the vault, in bytes. */
export const vaultValueBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** A file's bytes in base64. */
export const fileToBase64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Chunks keep each call under the engines' argument limits.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

/** The key ID in an App Store Connect key's file name, `AuthKey_<id>.p8`. */
export const ascKeyIdFromFileName = (fileName: string): string | undefined =>
  /^AuthKey_([A-Z0-9]+)\.p8$/u.exec(fileName)?.[1];

/** A variable row of a key/value secret's form. */
export interface VaultVariable {
  readonly name: string;
  readonly value: string;
}

/** The value a form's inputs make, for a kind with fields or variables. */
export const buildVaultValue = <TKind extends VaultSecretKind>(
  kind: TKind,
  input: {
    readonly fields: Readonly<Record<string, string>>;
    readonly variables: readonly VaultVariable[];
  },
): VaultSecretValues[TKind] => {
  const { fields } = vaultSecretKinds[kind];
  if (fields === null) {
    return Object.fromEntries(
      input.variables
        .filter(({ name, value }) => name.trim() !== "" || value !== "")
        .map(({ name, value }) => [name.trim(), value]),
    ) as VaultSecretValues[TKind];
  }
  return Object.fromEntries(
    fields.map(({ key }) => [key, input.fields[key] ?? ""]),
  ) as VaultSecretValues[TKind];
};

/** A secret name, as the vault takes one. */
export const VAULT_SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** An environment variable name, as key/value secrets take one. */
export const VAULT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Whether a token still works at `now`, or why not. */
export const vaultTokenState = (
  token: Pick<VaultToken, "expiresAtMs" | "revokedAtMs">,
  now: number,
): "active" | "revoked" | "expired" =>
  token.revokedAtMs !== null
    ? "revoked"
    : token.expiresAtMs !== null && token.expiresAtMs <= now
      ? "expired"
      : "active";
