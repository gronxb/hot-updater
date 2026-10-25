import type { CredentialKind } from "./credentialResolver";

/**
 * The environment variables that override each kind, one entry per field.
 * A field with two names takes a file path or the file's contents; the path
 * wins when both are set.
 */
export const CREDENTIAL_ENV_NAMES = {
  "asc-api-key": [
    ["HOT_UPDATER_ASC_KEY_PATH", "HOT_UPDATER_ASC_KEY"],
    ["HOT_UPDATER_ASC_KEY_ID"],
    ["HOT_UPDATER_ASC_ISSUER_ID"],
  ],
  "android-keystore": [
    [
      "HOT_UPDATER_ANDROID_KEYSTORE_PATH",
      "HOT_UPDATER_ANDROID_KEYSTORE_BASE64",
    ],
    ["HOT_UPDATER_ANDROID_KEYSTORE_PASSWORD"],
    ["HOT_UPDATER_ANDROID_KEY_ALIAS"],
    ["HOT_UPDATER_ANDROID_KEY_PASSWORD"],
  ],
  "play-service-account": [
    [
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    ],
  ],
} as const satisfies Record<
  CredentialKind,
  readonly (readonly [string] | readonly [string, string])[]
>;
