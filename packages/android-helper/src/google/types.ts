/** What stopped Hot Updater from issuing the Play service account key. */
export type PlayServiceAccountErrorCode =
  /** No OAuth client to sign in with, or Google refused it. */
  | "sign-in-not-configured"
  /** The browser sign-in was cancelled, refused, or timed out. */
  | "sign-in-cancelled"
  /** The account unticked a scope the setup needs on Google's consent screen. */
  | "scope-not-granted"
  /** The developer account ID names no Play Console account. */
  | "developer-not-found"
  /** The Google Account is no admin of the Play Console developer account. */
  | "not-play-admin"
  /** Google Play has no app with the package name in the developer account. */
  | "app-not-found"
  /** The Google Account may not create a Google Cloud project. */
  | "project-create-denied"
  /** The Google Account has no Google Cloud project quota left. */
  | "project-quota"
  /** The Google Account may not enable APIs or create service accounts in the project. */
  | "project-access-denied"
  /** Google is still enabling an API, or it is disabled in the OAuth client's project. */
  | "api-not-enabled"
  /** An organization policy (`iam.disableServiceAccountKeyCreation`) forbids keys. */
  | "key-creation-disabled";

/** A named failure of `issuePlayServiceAccount`, with what to do in its message. */
export class PlayServiceAccountError extends Error {
  readonly code: PlayServiceAccountErrorCode;

  constructor(
    code: PlayServiceAccountErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PlayServiceAccountError";
    this.code = code;
  }
}

/**
 * A Google OAuth client of type "Desktop app". Google treats an installed
 * app's client secret as public, so it ships with the client ID.
 */
export interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

/** The environment variables that replace Hot Updater's Google OAuth client. */
export const GOOGLE_OAUTH_CLIENT_ENV_NAMES = {
  clientId: "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID",
  clientSecret: "HOT_UPDATER_GOOGLE_OAUTH_CLIENT_SECRET",
} as const;

/** The service account Hot Updater creates, `hot-updater-play@<project>.iam.gserviceaccount.com`. */
export const PLAY_SERVICE_ACCOUNT_ID = "hot-updater-play";

/** Where a Play Console admin finds the developer account ID. */
export const PLAY_CONSOLE_URL = "https://play.google.com/console";
