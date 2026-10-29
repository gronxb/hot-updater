/** What stopped Hot Updater from issuing the Play service account key. */
export type PlayServiceAccountErrorCode =
  /** The gcloud CLI, which signs in to Google, is not installed. */
  | "gcloud-not-installed"
  /** gcloud ended with no Google Account to use: none signed in, or the sign-in was cancelled. */
  | "gcloud-not-signed-in"
  /** The Google Account may not create a Google Cloud project. */
  | "project-create-denied"
  /** The Google Account has no Google Cloud project quota left. */
  | "project-quota"
  /** The Google Account may not enable APIs or create service accounts in the project. */
  | "project-access-denied"
  /** Google is still enabling an API, or it is disabled in another project. */
  | "api-not-enabled"
  /** An organization policy (`iam.disableServiceAccountKeyCreation`) forbids keys. */
  | "key-creation-disabled"
  /** The key never reached the app: the Play Console invite, or the app's first upload, is missing. */
  | "play-access-pending";

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

/** The service account Hot Updater creates, `hot-updater-play@<project>.iam.gserviceaccount.com`. */
export const PLAY_SERVICE_ACCOUNT_ID = "hot-updater-play";
